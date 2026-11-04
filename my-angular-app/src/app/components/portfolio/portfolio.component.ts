import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, ElementRef, Injector, OnInit, TemplateRef, ViewChild, afterNextRender, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { catchError, finalize, forkJoin, from, map, mergeMap, of, Subscription, switchMap, take, tap } from 'rxjs';
import {
  PaperOrderReceipt, PendingOrderError, PendingPaperOrder, PortfolioPerformance, PortfolioService, ReferenceQuoteRequired, Stock, estimateOrderCents, paperOrderConfirmation,
} from '../../services/portfolio.service';

import { PortfolioPerformanceComponent } from './portfolio-performance.component';
import { MarketQuoteService, listQuoteRefreshMs, quoteBatchLimit } from '../../services/market-quote.service';
import { activeRefreshes, inViewport, visibleQuoteSymbols } from '../../services/market-refresh';

const allocationQuoteLifetimeMs = 7 * 24 * 60 * 60_000;

interface AllocationEntry {
  ticker: string | null;
  amount: number;
  weight: number;
  tone: number;
}

interface Holding extends Omit<Stock, 'price' | 'change'> {
  price: number | null;
  change: number | null;
  quotePending?: boolean;
  quotedAt?: number;
  previousQuote?: boolean;
}

type PositionSort = 'ticker' | 'quantity' | 'price' | 'dayChange' | 'marketValue' | 'weight' | 'unrealized';

@Component({
  selector: 'app-portfolio',
  standalone: true,
  imports: [CommonModule, FormsModule, MatProgressSpinnerModule, RouterLink, PortfolioPerformanceComponent],
  templateUrl: './portfolio.component.html',
  styleUrls: ['./portfolio.component.css', './portfolio-account.css', './portfolio-trade.css'],
})
export class PortfolioComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly marketQuotes = inject(MarketQuoteService);
  private tradeRef?: NgbModalRef;
  private portfolioRequest?: Subscription;
  private quoteRefreshRequest?: Subscription;
  private receiptRequest?: Subscription;
  private performanceRequest?: Subscription;
  private pendingTrade?: PendingPaperOrder;

  @ViewChild('tradeDialog', { static: true }) private tradeDialog!: TemplateRef<unknown>;
  readonly visibleAllocationEntries = 5;
  portfolio: Holding[] = [];
  private positionSort: { key: PositionSort; ascending: boolean } = { key: 'marketValue', ascending: false };
  cashBalance: number | null = null;
  walletInitialized: boolean | null = null;
  holdingsCurrent = false;
  isLoading = false;
  isInitializing = false;
  loadError = '';
  statusMessage = '';
  actionError = '';
  activeTrade?: { holding: Holding; side: 'buy' | 'sell'; price: number };
  tradeStage: 'draft' | 'review' | 'receipt' = 'draft';
  tradeReceipt?: PaperOrderReceipt;
  tradeError = '';
  tradeReference?: ReferenceQuoteRequired;
  referenceAcknowledged = false;
  submittingTrade = false;
  quantity: number | null = 1;
  receipts: PaperOrderReceipt[] = [];
  performance: PortfolioPerformance | null = null;
  performanceLoading = false;
  performanceFailed = false;
  pendingOrders: PendingPaperOrder[] = [];
  receiptsLoading = false;
  receiptsError = '';
  pendingError = '';
  checkingOrderId: string | null = null;

  constructor(
    private portfolioService: PortfolioService,
    private modal: NgbModal,
  ) {
    this.destroyRef.onDestroy(() => this.tradeRef?.close());
  }

  ngOnInit(): void {
    this.loadPortfolio();
    activeRefreshes(this.document, listQuoteRefreshMs).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshVisibleQuotes());
  }

  get marketValue(): number | null {
    return !this.holdingsCurrent || this.portfolio.some(stock => stock.price === null)
      ? null
      : this.portfolio.reduce((total, stock) => total + stock.quantity * (stock.price ?? 0), 0);
  }

  get accountValue(): number | null {
    const marketValue = this.marketValue;
    return marketValue === null || this.cashBalance === null ? null : this.cashBalance + marketValue;
  }

  holdingWeight(stock: Holding): number | null {
    const equity = this.accountValue;
    return equity !== null && equity > 0 && stock.price !== null ? stock.quantity * stock.price / equity : null;
  }

  holdingReturn(stock: Holding): number | null {
    return stock.totalCost > 0 && stock.price !== null ? stock.quantity * stock.price / stock.totalCost - 1 : null;
  }

  get sortedPortfolio(): Holding[] {
    const { key, ascending } = this.positionSort;
    const direction = ascending ? 1 : -1;
    const rows = this.portfolio.map(stock => ({ stock, value: this.positionValue(stock, key) }));
    rows.sort((first, second) => {
      const a = first.value;
      const b = second.value;
      if (a === null && b !== null) return 1;
      if (b === null && a !== null) return -1;
      const order = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b)
        : typeof a === 'number' && typeof b === 'number' ? a - b : 0;
      return order * direction || first.stock.ticker.localeCompare(second.stock.ticker);
    });
    return rows.map(({ stock }) => stock);
  }

  sortPositions(key: PositionSort): void {
    const previous = this.positionSort;
    this.positionSort = { key, ascending: previous.key === key ? !previous.ascending : key === 'ticker' };
  }

  sortState(key: PositionSort): 'ascending' | 'descending' | null {
    return this.positionSort.key !== key ? null : this.positionSort.ascending ? 'ascending' : 'descending';
  }

  private positionValue(stock: Holding, key: PositionSort): string | number | null {
    const market = stock.price === null ? null : stock.quantity * stock.price;
    switch (key) {
      case 'ticker': return stock.ticker;
      case 'quantity': return stock.quantity;
      case 'price': return stock.price;
      case 'dayChange': return stock.change;
      case 'marketValue': return market;
      case 'weight': return this.holdingWeight(stock);
      case 'unrealized': return market === null ? null : market - stock.totalCost;
    }
  }

  get portfolioPrepared(): boolean {
    return this.performance?.prepared === true || this.receipts.some(receipt => receipt.source === 'prepared');
  }

  get showcaseClaimError(): string {
    return this.portfolioService.showcaseClaimError;
  }

  get allocation(): { entries: AllocationEntry[]; message?: string } {
    const unavailable = (message: string) => ({ entries: [], message });
    if (this.isLoading || (this.quotesPending && this.accountValue === null)) return unavailable('Calculating allocation…');
    if (this.walletInitialized === false) return unavailable('Initialize your paper wallet to see allocation.');
    if (!this.holdingsCurrent || this.cashBalance === null) return unavailable('Cash or holdings could not be loaded.');

    const equity = this.accountValue;
    if (equity === null) {
      return unavailable(`Allocation needs a price for every holding. ${this.quotedCount} of ${this.portfolio.length} priced.`);
    }
    if (this.portfolio.length) {
      const oldestQuote = this.oldestQuote;
      if (oldestQuote === null) return unavailable('Allocation needs a quote time for every holding.');
      if (Date.now() - oldestQuote > allocationQuoteLifetimeMs) {
        return unavailable('A holding quote is more than seven days old. Allocation will update with a newer quote.');
      }
    }
    if (!Number.isFinite(equity) || equity <= 0 || this.cashBalance < 0) {
      return unavailable('Allocation appears when the account has a positive value.');
    }

    const holdings = this.portfolio
      .map(stock => ({ ticker: stock.ticker, amount: stock.quantity * (stock.price ?? 0) }))
      .sort((first, second) => second.amount - first.amount || first.ticker.localeCompare(second.ticker));
    return {
      entries: [
        { ticker: null, amount: this.cashBalance, weight: this.cashBalance / equity, tone: 0 },
        ...holdings.map((holding, index) => ({ ...holding, weight: holding.amount / equity, tone: Math.min(index + 1, this.visibleAllocationEntries) })),
      ],
    };
  }

  trackByAllocation(_index: number, entry: AllocationEntry): string {
    return entry.ticker ?? '';
  }

  get unrealizedProfit(): number | null {
    const marketValue = this.marketValue;
    return marketValue === null ? null : marketValue - this.portfolio.reduce((total, stock) => total + stock.totalCost, 0);
  }

  get oldestQuote(): number | null {
    if (!this.holdingsCurrent || !this.portfolio.length || this.portfolio.some(stock => stock.quotedAt === undefined)) return null;
    return Math.min(...this.portfolio.map(stock => stock.quotedAt!));
  }

  get quotesPending(): boolean {
    return this.portfolio.some(stock => stock.quotePending);
  }

  get quotedCount(): number {
    return this.portfolio.filter(stock => stock.price !== null).length;
  }

  get isRetryingTrade(): boolean {
    return Boolean(this.pendingTrade);
  }

  get tradeQuote(): { price: number; quotedAt?: string | number } | undefined {
    return this.tradeReference?.quote ?? this.pendingTrade?.referenceQuote ?? (this.activeTrade && {
      price: this.activeTrade.price,
      quotedAt: this.activeTrade.holding.quotedAt,
    });
  }

  get quantityLimit(): number {
    const trade = this.activeTrade;
    if (!trade) return 0;

    const selling = trade.side === 'sell';
    const maxCents = selling ? Number.MAX_SAFE_INTEGER : Math.round((this.cashBalance ?? 0) * 100);
    const price = this.tradeQuote?.price ?? trade.price;
    // Round the full order the same way as execution, including prices below one cent.
    let lower = 0;
    let upper = selling ? trade.holding.quantity : Number.MAX_SAFE_INTEGER;
    while (lower < upper) {
      const middle = lower + Math.ceil((upper - lower) / 2);
      if (estimateOrderCents(price, middle) <= maxCents) lower = middle;
      else upper = middle - 1;
    }
    return lower;
  }

  get estimatedTotal(): number | null {
    if (!this.validQuantity || !this.activeTrade || this.quantity === null) return null;
    const cents = estimateOrderCents(this.tradeQuote?.price ?? this.activeTrade.price, this.quantity);
    return Number.isSafeInteger(cents) ? cents / 100 : null;
  }

  get quantityError(): string {
    if (!this.validQuantity) return 'Enter a positive whole number of shares.';
    if (!this.activeTrade || this.pendingTrade || this.quantity === null) return '';
    if (this.quantity > this.quantityLimit) {
      return this.activeTrade.side === 'buy'
        ? 'The estimated cost exceeds your available cash.'
        : 'This order exceeds your sell limit.';
    }
    return this.estimatedTotal === 0 ? 'The estimated order value must be at least $0.01.' : '';
  }

  useMaximumQuantity(): void {
    if (this.submittingTrade || this.pendingTrade || this.tradeReference) return;
    const maximum = this.quantityLimit;
    if (maximum > 0) this.quantity = maximum;
  }

  get validQuantity(): boolean {
    return this.quantity !== null && Number.isSafeInteger(this.quantity) && this.quantity > 0;
  }

  get canSubmitTrade(): boolean {
    const trade = this.activeTrade;
    if (!trade || this.tradeStage === 'receipt' || !this.validQuantity || this.submittingTrade || this.checkingOrderId) return false;
    if (this.tradeReference && !this.referenceAcknowledged) return false;
    return Boolean(this.pendingTrade) || !this.quantityError;
  }

  loadPortfolio(force = false): void {
    if (!force && (this.isLoading || (this.portfolioRequest && !this.portfolioRequest.closed))) return;
    this.quoteRefreshRequest?.unsubscribe();
    this.loadReceipts(force);
    this.loadPerformance(force);
    this.portfolioRequest?.unsubscribe();
    const previous = new Map(this.portfolio.map(holding => [holding.ticker, holding]));
    this.isLoading = true;
    this.holdingsCurrent = false;
    this.loadError = '';

    this.portfolioRequest = forkJoin({
      holdings: this.portfolioService.getStocks().pipe(catchError(() => of(null))),
      wallet: this.portfolioService.getBalance().pipe(catchError(() => of(null))),
    }).pipe(
      tap(({ holdings, wallet }) => {
        if (holdings) {
          this.portfolio = holdings.map(stock => {
            const known = previous.get(stock.ticker);
            return { ...stock, price: known?.price ?? null, change: known?.change ?? null,
              quotedAt: known?.quotedAt, previousQuote: known?.previousQuote, quotePending: true };
          });
        } else {
          this.portfolio = this.portfolio.map(stock => ({ ...stock, quotePending: false }));
        }
        this.holdingsCurrent = holdings !== null;
        this.cashBalance = wallet?.balance ?? null;
        this.walletInitialized = wallet ? (wallet.initialized ?? (wallet.balance > 0 || !!holdings?.length)) : null;
        if (!holdings || !wallet) {
          this.loadError = !holdings && !wallet
            ? 'We couldn’t load your holdings or wallet.'
            : !holdings
              ? 'We couldn’t load your latest holdings.'
              : 'We couldn’t load your wallet balance.';
        }
        this.isLoading = false;
      }),
      switchMap(({ holdings }) => from(holdings ? this.portfolio : []).pipe(mergeMap(stock => this.enrichQuote(stock), 3))),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.isLoading = false),
    ).subscribe(enriched => {
      this.portfolio = this.portfolio.map(stock => stock.ticker === enriched.ticker ? enriched : stock);
    });
  }

  get previousQuoteCount(): number {
    return this.portfolio.filter(stock => stock.previousQuote).length;
  }

  get quoteRecoveryNeeded(): boolean {
    return this.holdingsCurrent && !this.quotesPending && this.portfolio.some(stock => stock.price === null || stock.previousQuote);
  }

  refreshVisibleQuotes(retry = false): void {
    if (!this.holdingsCurrent || this.isLoading || this.isInitializing || this.tradeRef || this.checkingOrderId
      || this.quotesPending || this.document.hidden || this.document.defaultView?.navigator.onLine === false) return;

    const host = this.host.nativeElement;
    const visible = new Set(visibleQuoteSymbols(host, quoteBatchLimit));
    const targets = this.portfolio.filter(stock => retry ? stock.price === null || stock.previousQuote : visible.has(stock.ticker))
      .slice(0, quoteBatchLimit);
    const account = host.querySelector('#account-title');
    if (!retry && account && inViewport(account) && targets.length < quoteBatchLimit) {
      const oldest = this.portfolio.filter(stock => !visible.has(stock.ticker))
        .sort((first, second) => (first.quotedAt ?? 0) - (second.quotedAt ?? 0));
      targets.push(...oldest.slice(0, quoteBatchLimit - targets.length));
    }
    if (!targets.length) return;
    const requested = new Set(targets.map(stock => stock.ticker));
    this.portfolio = this.portfolio.map(stock => requested.has(stock.ticker) ? { ...stock, quotePending: true } : stock);
    this.quoteRefreshRequest = from(targets).pipe(
      mergeMap(stock => this.enrichQuote(stock), 3),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(updated => this.portfolio = this.portfolio.map(stock => stock.ticker === updated.ticker ? updated : stock));
  }

  private enrichQuote(stock: Holding) {
    return this.marketQuotes.read(stock.ticker).pipe(map(({ quote, previous }): Holding => {
      const usePrevious = stock.price !== null && (!quote || (stock.quotedAt !== undefined && quote.t * 1000 < stock.quotedAt));
      return {
        ...stock,
        price: usePrevious ? stock.price : quote?.c ?? null,
        change: usePrevious ? stock.change : quote && Number.isFinite(quote.dp) ? quote.dp : null,
        quotedAt: usePrevious ? stock.quotedAt : quote ? quote.t * 1000 : undefined,
        previousQuote: previous || usePrevious,
        quotePending: false,
      };
    }));
  }

  onInitializeWallet(): void {
    if (this.isInitializing || this.isLoading || this.walletInitialized !== false) return;
    this.isInitializing = true;
    this.actionError = '';
    this.statusMessage = '';
    this.portfolioService.initializeWallet().pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.isInitializing = false),
    ).subscribe({
      next: ({ message }) => {
        this.statusMessage = message;
        this.loadPortfolio();
      },
      error: () => this.actionError = 'We couldn’t initialize the wallet. Please try again.',
    });
  }

  jumpToHeading(heading: HTMLElement): void {
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start' });
  }

  canOpenTrade(holding: Holding, side: 'buy' | 'sell'): boolean {
    if (this.checkingOrderId || this.isLoading || this.isInitializing || !this.holdingsCurrent || !this.walletInitialized || holding.price === null) return false;
    const cents = estimateOrderCents(holding.price, 1);
    if (!Number.isSafeInteger(cents)) return false;
    return side === 'buy'
      ? this.cashBalance !== null && Math.round(this.cashBalance * 100) >= Math.max(1, cents)
      : holding.quantity > 0;
  }

  openTrade(holding: Holding, side: 'buy' | 'sell'): void {
    if (this.tradeRef || holding.price === null || !this.canOpenTrade(holding, side)) return;
    this.actionError = '';
    this.statusMessage = '';
    const pending = this.portfolioService.getPendingOrder(side, holding.ticker);
    this.pendingTrade = pending;
    this.tradeStage = pending ? 'review' : 'draft';
    this.tradeReceipt = undefined;
    this.tradeReference = undefined;
    this.referenceAcknowledged = false;
    this.tradeError = pending ? 'This order is awaiting confirmation. Retry with the original order ID.' : '';
    this.quantity = pending?.quantity ?? 1;
    this.activeTrade = { holding, side, price: holding.price };
    this.tradeRef = this.modal.open(this.tradeDialog, {
      windowClass: 'portfolio-trade-window',
      backdropClass: 'portfolio-trade-backdrop',
      ariaLabelledBy: 'portfolio-trade-title',
      beforeDismiss: () => !this.submittingTrade,
    });
    this.tradeRef.hidden.pipe(take(1), takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      afterNextRender(() => {
        // The modal normally returns focus to its trigger, which a complete sale can remove.
        setTimeout(() => {
          if (this.document.activeElement === this.document.body) {
            this.document.getElementById('positions-title')?.focus();
          }
        });
      }, { injector: this.injector });
    });
    const clearTrade = () => {
      this.tradeRef = undefined;
      this.activeTrade = undefined;
      this.tradeReceipt = undefined;
    };
    this.tradeRef.result.then(clearTrade, clearTrade);
  }

  submitTrade(): void {
    const trade = this.activeTrade;
    const quantity = this.quantity;
    if (!trade || quantity === null || !this.canSubmitTrade) return;

    if (this.tradeStage === 'draft') {
      this.tradeStage = 'review';
      this.tradeError = '';
      this.focusTradeHeading();
      return;
    }

    this.submittingTrade = true;
    this.tradeError = '';
    const ticker = trade.holding.ticker;
    const request = this.tradeReference
      ? this.portfolioService.confirmReferenceQuote(this.tradeReference)
      : this.pendingTrade
        ? this.portfolioService.retryOrder(this.pendingTrade)
        : this.portfolioService.placeOrder(trade.side, ticker, quantity);

    request.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.submittingTrade = false),
    ).subscribe({
      next: receipt => {
        this.tradeReceipt = receipt;
        this.tradeStage = 'receipt';
        this.focusTradeHeading();
        this.loadPortfolio(true);
      },
      error: (error: unknown) => {
        this.tradeReference = error instanceof ReferenceQuoteRequired ? error : undefined;
        this.referenceAcknowledged = false;
        this.pendingTrade = error instanceof PendingOrderError ? error.order : undefined;
        if (this.isRetryingTrade) {
          this.tradeError = 'This order is awaiting confirmation. Retry it here or close this ticket and check Order activity.';
        } else if (!this.tradeReference) {
          this.tradeError = error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
            ? error.error.message : 'The order could not be sent. Please try again.';
        }
        if (this.tradeReference || this.pendingTrade) this.focusTradeHeading();
        if (!this.tradeReference) this.loadPortfolio();
      },
    });
  }

  editTrade(): void {
    if (this.submittingTrade || this.isRetryingTrade || this.tradeStage !== 'review') return;
    this.tradeStage = 'draft';
    this.tradeReference = undefined;
    this.referenceAcknowledged = false;
    this.tradeError = '';
    afterNextRender(() => this.document.getElementById('portfolio-trade-quantity')?.focus(), { injector: this.injector });
  }

  viewTradeReceipt(): void {
    const receipt = this.tradeReceipt;
    const dialog = this.tradeRef;
    if (!receipt || !dialog) return;
    dialog.hidden.pipe(take(1), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.focusLedgerReceipt(receipt));
    dialog.close();
  }

  private focusTradeHeading(): void {
    afterNextRender(() => this.document.getElementById('portfolio-trade-title')?.focus(), { injector: this.injector });
  }

  private focusLedgerReceipt(receipt: PaperOrderReceipt): void {
    // The confirmed response already contains a durable receipt, even if the ledger refresh is unavailable.
    if (!this.receipts.some(order => order.orderId === receipt.orderId)) this.receipts = [receipt, ...this.receipts];
    afterNextRender(() => {
      const row = this.document.getElementById(`portfolio-receipt-${receipt.orderId}`);
      if (!(row instanceof HTMLDetailsElement)) return;
      row.open = true;
      // ng-bootstrap restores the opening button on a timer when its dialog closes.
      setTimeout(() => {
        if (!row.isConnected) return;
        row.querySelector('summary')?.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'center' });
      });
    }, { injector: this.injector });
  }

  loadPerformance(force = false): void {
    if (this.performanceLoading && !force) return;
    this.performanceRequest?.unsubscribe();
    this.performanceLoading = true;
    this.performanceFailed = false;
    this.performanceRequest = this.portfolioService.getPerformance().pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.performanceLoading = false),
    ).subscribe({
      next: history => {
        this.performance = history;
        this.performanceFailed = history.status === 'temporarily_unavailable';
      },
      error: () => {
        this.performance = null;
        this.performanceFailed = true;
      },
    });
  }

  loadReceipts(force = false): void {
    if (this.receiptsLoading && !force) return;
    this.receiptRequest?.unsubscribe();
    this.receiptsLoading = true;
    this.receiptsError = '';
    this.pendingOrders = this.portfolioService.getPendingOrders();
    this.receiptRequest = this.portfolioService.getReceipts().pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.receiptsLoading = false),
    ).subscribe({
      next: receipts => {
        this.receipts = receipts;
        this.pendingOrders = this.portfolioService.getPendingOrders();
      },
      error: () => this.receiptsError = 'Order receipts could not load. Please try again.',
    });
  }

  retryPendingOrder(order: PendingPaperOrder): void {
    if (this.tradeRef || this.submittingTrade || this.checkingOrderId || this.isLoading || this.isInitializing) return;
    this.checkingOrderId = order.orderId;
    this.pendingError = '';
    this.portfolioService.retryOrder(order).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.checkingOrderId = null),
    ).subscribe({
      next: receipt => {
        this.statusMessage = paperOrderConfirmation(receipt);
        this.loadPortfolio(true);
        this.focusLedgerReceipt(receipt);
      },
      error: (error: unknown) => {
        this.pendingError = error instanceof PendingOrderError
          ? 'Order confirmation is still unavailable. You can retry again with the same ID.'
          : error instanceof ReferenceQuoteRequired
            ? 'The order was not filled. Open a new trade ticket to review the available reference quote.'
            : error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
              ? error.error.message : 'The order could not be sent. Please try again.';
        this.loadPortfolio();
      },
    });
  }

  trackByTicker(_index: number, stock: Holding): string {
    return stock.ticker;
  }
}
