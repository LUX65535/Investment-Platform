import { Component, DestroyRef, OnInit, TemplateRef, ViewChild, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { catchError, finalize, forkJoin, from, map, mergeMap, of, Subscription, switchMap, tap } from 'rxjs';
import { PortfolioService, Stock } from '../../services/portfolio.service';

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
    return this.portfolio.some(stock => stock.price === null)
      ? null
      : this.portfolio.reduce((total, stock) => total + stock.quantity * (stock.price ?? 0), 0);
  }

  get estimatedTotal(): number {
    return (this.quantity ?? 0) * (this.activeTrade?.price ?? 0);
  }

  get validQuantity(): boolean {
    return this.quantity !== null && Number.isSafeInteger(this.quantity) && this.quantity > 0;
  }

  get canSubmitTrade(): boolean {
    const trade = this.activeTrade;
    if (!trade || !this.validQuantity || this.submittingTrade || this.tradeNeedsRefresh || this.quantity === null) return false;
    return trade.side === 'sell'
      ? this.quantity <= trade.holding.quantity
      : this.cashBalance !== null && this.estimatedTotal <= this.cashBalance;
  }

  loadPortfolio(): void {
    if (this.isLoading) return;
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

  openTrade(holding: Holding, side: 'buy' | 'sell'): void {
    if (this.tradeRef || holding.price === null || this.isLoading || !this.holdingsCurrent || !this.walletInitialized) return;
    this.actionError = '';
    this.statusMessage = '';
    this.tradeError = '';
    this.tradeNeedsRefresh = false;
    this.quantity = 1;
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
    const request = trade.side === 'buy'
      ? this.portfolioService.buyStock(ticker, quantity, trade.price)
      : this.portfolioService.sellStock(ticker, quantity, trade.price);

    request.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.submittingTrade = false),
    ).subscribe({
      next: () => {
        this.statusMessage = `${trade.side === 'buy' ? 'Bought' : 'Sold'} ${quantity} ${quantity === 1 ? 'share' : 'shares'} of ${ticker}.`;
        this.tradeRef?.close();
        this.loadPortfolio();
      },
      error: (error: HttpErrorResponse) => {
        if (error.status === 0 || error.status >= 500) {
          this.tradeNeedsRefresh = true;
          this.tradeError = 'We couldn’t confirm this trade. Close this dialog and check your refreshed holdings before trying again.';
          this.loadPortfolio();
        } else {
          this.tradeError = typeof error.error?.message === 'string' ? error.error.message : 'The trade was rejected. Please try again.';
        }
      },
    });
  }

  trackByTicker(_index: number, stock: Holding): string {
    return stock.ticker;
  }
}
