import { Component, DestroyRef, ElementRef, OnInit, ViewChild, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, finalize, forkJoin, from, map, mergeMap, of, switchMap, tap } from 'rxjs';

interface Quote {
  c: number;
  d: number | null;
  dp: number | null;
}

interface WatchlistItem {
  ticker: string;
  name?: string;
  quote?: Quote;
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
  loading = false;
  hasLoaded = false;
  private enriching = false;
  loadError = '';
  actionError = '';
  actionStatus = '';

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadWatchlist();
  }

  get canRefresh(): boolean {
    return !this.loading && !this.enriching && this.removing.size === 0;
  }

  loadWatchlist(): void {
    if (!this.canRefresh) return;
    this.loading = true;
    this.loadError = '';
    this.http.get<WatchlistItem[]>('/api/watchlist').pipe(
      tap(items => {
        this.watchlist = items.map(({ ticker }) => ({ ticker, quotePending: true }));
        this.hasLoaded = true;
        this.loading = false;
        this.enriching = items.length > 0;
      }),
      switchMap(items => from(items).pipe(mergeMap(({ ticker }) => {
        const params = { symbol: ticker };
        return forkJoin({
          profile: this.http.get<{ name?: string }>('/company_profile', { params }).pipe(
            catchError(() => of(null)),
          ),
          quote: this.http.get<Quote>('/company_quote', { params }).pipe(
            catchError(() => of(null)),
          ),
        }).pipe(map(({ profile, quote }): WatchlistItem => ({
          ticker,
          name: profile?.name,
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
      error: () => this.loadError = 'We couldn’t load your watchlist. Try again in a moment.',
    });
  }

  removeStock(ticker: string, button: HTMLButtonElement): void {
    if (this.loading || this.removing.has(ticker)) return;
    this.actionError = '';
    this.actionStatus = '';
    this.removing.add(ticker);
    this.http.delete(`/api/watchlist/${encodeURIComponent(ticker)}`).pipe(
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
