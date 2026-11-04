import { Component, DestroyRef, OnInit, TemplateRef, ViewChild, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { catchError, finalize, forkJoin, from, map, mergeMap, of, Subscription, switchMap, tap } from 'rxjs';
import {
  PaperOrderReceipt, PendingOrderError, PendingPaperOrder, PortfolioService, Stock, paperOrderConfirmation,
} from '../../services/portfolio.service';

interface Holding extends Omit<Stock, 'price' | 'change'> {
  price: number | null;
  change: number | null;
  quotePending?: boolean;
}

@Component({
  selector: 'app-portfolio',
  templateUrl: './portfolio.component.html',
  styleUrls: ['./portfolio.component.css'],
})
export class PortfolioComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private tradeRef?: NgbModalRef;
  private portfolioRequest?: Subscription;
  private receiptRequest?: Subscription;
  private pendingTrade?: PendingPaperOrder;

  @ViewChild('tradeDialog', { static: true }) private tradeDialog!: TemplateRef<unknown>;
  portfolio: Holding[] = [];
  cashBalance: number | null = null;
  walletInitialized: boolean | null = null;
  holdingsCurrent = false;
  isLoading = false;
  isInitializing = false;
  loadError = '';
  statusMessage = '';
  actionError = '';
  activeTrade?: { holding: Holding; side: 'buy' | 'sell'; price: number };
  tradeError = '';
  tradeNeedsRefresh = false;
  submittingTrade = false;
  quantity: number | null = 1;
  receipts: PaperOrderReceipt[] = [];
  pendingOrders: PendingPaperOrder[] = [];
  receiptsLoading = false;
  receiptsError = '';
  pendingError = '';
  checkingOrderId: string | null = null;

  constructor(
    private portfolioService: PortfolioService,
    private http: HttpClient,
    private modal: NgbModal,
  ) {
    this.destroyRef.onDestroy(() => this.tradeRef?.close());
  }

  ngOnInit(): void {
    this.loadPortfolio();
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

  get unrealizedProfit(): number | null {
    const marketValue = this.marketValue;
    return marketValue === null ? null : marketValue - this.portfolio.reduce((total, stock) => total + stock.totalCost, 0);
  }

  get quotesPending(): boolean {
    return this.portfolio.some(stock => stock.quotePending);
  }

  get quotedCount(): number {
    return this.portfolio.filter(stock => stock.price !== null).length;
  }

  get estimatedTotal(): number {
    return (this.quantity ?? 0) * (this.activeTrade?.price ?? 0);
  }

  get validQuantity(): boolean {
    return this.quantity !== null && Number.isSafeInteger(this.quantity) && this.quantity > 0;
  }

  get canSubmitTrade(): boolean {
    const trade = this.activeTrade;
    if (!trade || !this.validQuantity || this.submittingTrade || this.checkingOrderId || this.quantity === null) return false;
    if (this.tradeNeedsRefresh) return true;
    return trade.side === 'sell'
      ? this.quantity <= trade.holding.quantity
      : this.cashBalance !== null && this.estimatedTotal <= this.cashBalance;
  }

  loadPortfolio(): void {
    if (this.isLoading) return;
    this.loadReceipts();
    this.portfolioRequest?.unsubscribe();
    this.isLoading = true;
    this.holdingsCurrent = false;
    this.loadError = '';

    this.portfolioRequest = forkJoin({
      holdings: this.portfolioService.getStocks().pipe(catchError(() => of(null))),
      wallet: this.portfolioService.getBalance().pipe(catchError(() => of(null))),
    }).pipe(
      tap(({ holdings, wallet }) => {
        if (holdings) {
          this.portfolio = holdings.map(stock => ({ ...stock, price: null, change: null, quotePending: true }));
        } else {
          this.portfolio = this.portfolio.map(stock => ({ ...stock, quotePending: false }));
        }
        this.holdingsCurrent = holdings !== null;
        this.cashBalance = wallet?.balance ?? null;
        this.walletInitialized = wallet ? (wallet.initialized ?? (wallet.balance > 0 || !!holdings?.length)) : null;
        if (!holdings || !wallet) {
          this.loadError = !holdings && !wallet
            ? 'We couldn’t load your holdings or wallet. Try refreshing.'
            : !holdings
              ? 'We couldn’t refresh your holdings.'
              : 'We couldn’t load your wallet balance.';
        }
        this.isLoading = false;
      }),
      switchMap(({ holdings }) => from(holdings ?? []).pipe(mergeMap(stock =>
        this.http.get<{ c: number; dp: number }>('/company_quote', { params: { symbol: stock.ticker } }).pipe(
          catchError(() => of(null)),
          map((quote): Holding => ({
            ...stock,
            price: quote && Number.isFinite(quote.c) && quote.c > 0 ? quote.c : null,
            change: quote && quote.c > 0 && Number.isFinite(quote.dp) ? quote.dp : null,
          })),
        ), 3))),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.isLoading = false),
    ).subscribe(enriched => {
      this.portfolio = this.portfolio.map(stock => stock.ticker === enriched.ticker ? enriched : stock);
    });
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

  canOpenTrade(holding: Holding, side: 'buy' | 'sell'): boolean {
    if (this.checkingOrderId || this.isLoading || this.isInitializing || !this.holdingsCurrent || !this.walletInitialized || holding.price === null) return false;
    return side === 'buy' ? this.cashBalance !== null && this.cashBalance > 0 : holding.quantity > 0;
  }

  openTrade(holding: Holding, side: 'buy' | 'sell'): void {
    if (this.tradeRef || holding.price === null || !this.canOpenTrade(holding, side)) return;
    this.actionError = '';
    this.statusMessage = '';
    const pending = this.portfolioService.getPendingOrder(side, holding.ticker);
    this.pendingTrade = pending;
    this.tradeError = pending ? 'This order is awaiting confirmation. Retry with the original order ID.' : '';
    this.tradeNeedsRefresh = Boolean(pending);
    this.quantity = pending?.quantity ?? 1;
    this.activeTrade = { holding, side, price: holding.price };
    this.tradeRef = this.modal.open(this.tradeDialog, {
      centered: true,
      windowClass: 'trade-window',
      ariaLabelledBy: 'portfolio-trade-title',
      beforeDismiss: () => !this.submittingTrade,
    });
    const clearTrade = () => {
      this.tradeRef = undefined;
      this.activeTrade = undefined;
    };
    this.tradeRef.result.then(clearTrade, clearTrade);
  }

  submitTrade(): void {
    const trade = this.activeTrade;
    const quantity = this.quantity;
    if (!trade || quantity === null || !this.canSubmitTrade) return;

    this.submittingTrade = true;
    this.tradeError = '';
    const ticker = trade.holding.ticker;
    const request = this.pendingTrade
      ? this.portfolioService.retryOrder(this.pendingTrade)
      : this.portfolioService.placeOrder(trade.side, ticker, quantity);

    request.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.submittingTrade = false),
    ).subscribe({
      next: receipt => {
        this.statusMessage = paperOrderConfirmation(receipt);
        this.tradeRef?.close();
        this.loadPortfolio();
      },
      error: (error: HttpErrorResponse | PendingOrderError) => {
        this.pendingTrade = error instanceof PendingOrderError ? error.order : undefined;
        this.tradeNeedsRefresh = Boolean(this.pendingTrade);
        if (this.tradeNeedsRefresh) {
          this.tradeError = 'This order is awaiting confirmation. Retry the same order here or from Orders.';
        } else {
          this.tradeError = error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
            ? error.error.message : 'The order could not be sent. Please try again.';
        }
        this.loadReceipts();
      },
    });
  }

  loadReceipts(): void {
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
    if (this.submittingTrade || this.checkingOrderId) return;
    this.checkingOrderId = order.orderId;
    this.pendingError = '';
    this.portfolioService.retryOrder(order).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.checkingOrderId = null),
    ).subscribe({
      next: receipt => {
        this.statusMessage = paperOrderConfirmation(receipt);
        this.loadPortfolio();
      },
      error: (error: HttpErrorResponse | PendingOrderError) => {
        this.pendingError = error instanceof PendingOrderError
          ? 'Order confirmation is still unavailable. You can retry again with the same ID.'
          : error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
            ? error.error.message : 'The order could not be sent. Please try again.';
        this.loadReceipts();
      },
    });
  }

  trackByTicker(_index: number, stock: Holding): string {
    return stock.ticker;
  }
}
