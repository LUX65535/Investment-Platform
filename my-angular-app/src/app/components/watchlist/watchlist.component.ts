import { Component, DestroyRef, ElementRef, OnInit, ViewChild, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, finalize, forkJoin, from, map, mergeMap, of, switchMap, tap } from 'rxjs';
import { PortfolioService } from '../../services/portfolio.service';

interface Quote {
  c: number;
  d: number | null;
  dp: number | null;
  t?: number;
}

type SortKey = 'symbol' | 'price' | 'change' | 'changePercent';

interface WatchlistItem {
  ticker: string;
  name?: string;
  currency?: string;
  quote?: Quote;
  quotedAt?: number;
  quotePending?: boolean;
}

@Component({
  selector: 'app-watchlist',
  templateUrl: './watchlist.component.html',
  styleUrls: ['./watchlist.component.css'],
})
export class WatchlistComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  @ViewChild('listTitle', { static: true }) private listTitle!: ElementRef<HTMLElement>;
  readonly removing = new Set<string>();
  watchlist: WatchlistItem[] = [];
  sortKey: SortKey = 'symbol';
  ascending = true;
  loading = false;
  hasLoaded = false;
  private enriching = false;
  loadError = '';
  actionError = '';
  actionStatus = '';

  constructor(private http: HttpClient, private portfolioService: PortfolioService) {}

  ngOnInit(): void {
    this.loadWatchlist();
  }

  get sortedWatchlist(): WatchlistItem[] {
    const direction = this.ascending ? 1 : -1;
    return [...this.watchlist].sort((first, second) => {
      const symbolOrder = first.ticker.localeCompare(second.ticker);
      if (this.sortKey === 'symbol') return direction * symbolOrder;

      const a = this.sortValue(first);
      const b = this.sortValue(second);
      if (a === null) return b === null ? symbolOrder : 1;
      if (b === null) return -1;
      return direction * (a - b) || symbolOrder;
    });
  }

  sortBy(key: SortKey): void {
    this.ascending = this.sortKey === key ? !this.ascending : key === 'symbol';
    this.sortKey = key;
  }

  sortDirection(key: SortKey): 'ascending' | 'descending' | null {
    return this.sortKey === key ? (this.ascending ? 'ascending' : 'descending') : null;
  }

  private sortValue(item: WatchlistItem): number | null {
    if (!item.quote) return null;
    if (this.sortKey === 'price') return item.quote.c;
    return this.sortKey === 'change' ? item.quote.d : item.quote.dp;
  }

  get quotedCount(): number {
    return this.watchlist.filter(item => item.quote).length;
  }

  get quotesPending(): boolean {
    return this.watchlist.some(item => item.quotePending);
  }

  get canRefresh(): boolean {
    return !this.loading && !this.enriching && this.removing.size === 0;
  }

  loadWatchlist(): void {
    if (!this.canRefresh) return;
    this.loading = true;
    this.loadError = '';
    this.actionStatus = '';
    this.portfolioService.getWatchlist().pipe(
      tap(items => {
        this.watchlist = items.map(({ ticker }) => ({ ticker, quotePending: true }));
        this.hasLoaded = true;
        this.loading = false;
        this.enriching = items.length > 0;
      }),
      switchMap(items => from(items).pipe(mergeMap(({ ticker }) => {
        const params = { symbol: ticker };
        return forkJoin({
          profile: this.http.get<{ name?: string; currency?: string }>('/company_profile', { params }).pipe(
            catchError(() => of(null)),
          ),
          quote: this.http.get<Quote>('/company_quote', { params }).pipe(
            catchError(() => of(null)),
          ),
        }).pipe(map(({ profile, quote }): WatchlistItem => ({
          ticker,
          name: profile?.name,
          currency: typeof profile?.currency === 'string' && /^[A-Z]{3}$/.test(profile.currency) ? profile.currency : undefined,
          quotedAt: quote?.t && Number.isSafeInteger(quote.t) && quote.t > 0 && quote.t <= Date.now() / 1000 + 60
            ? quote.t * 1000 : undefined,
          quote: quote && Number.isFinite(quote.c) && quote.c > 0 ? {
            c: quote.c,
            d: Number.isFinite(quote.d) ? quote.d : null,
            dp: Number.isFinite(quote.dp) ? quote.dp : null,
          } : undefined,
        })));
      }, 3))),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => {
        this.loading = false;
        this.enriching = false;
      }),
    ).subscribe({
      next: enriched => this.watchlist = this.watchlist.map(item => item.ticker === enriched.ticker ? enriched : item),
      error: () => this.loadError = this.hasLoaded
        ? 'We couldn’t refresh your watchlist. Showing the last loaded list.'
        : 'We couldn’t load your watchlist. Try again in a moment.',
    });
  }

  removeStock(ticker: string, button: HTMLButtonElement): void {
    if (this.loading || this.removing.has(ticker)) return;
    this.actionError = '';
    this.actionStatus = '';
    this.removing.add(ticker);
    this.portfolioService.removeWatchlist(ticker).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.removing.delete(ticker)),
    ).subscribe({
      next: () => {
        if (button.ownerDocument.activeElement === button) {
          const row = button.closest('tr');
          const sibling = row?.nextElementSibling ?? row?.previousElementSibling;
          const nextTarget = sibling?.querySelector('a') ?? this.listTitle.nativeElement;
          nextTarget.focus({ preventScroll: true });
        }
        this.watchlist = this.watchlist.filter(item => item.ticker !== ticker);
        this.actionStatus = `${ticker} removed from your watchlist.`;
      },
      error: () => this.actionError = `Couldn’t remove ${ticker}. Please try again.`,
    });
  }

  trackByTicker(_index: number, item: WatchlistItem): string {
    return item.ticker;
  }
}
