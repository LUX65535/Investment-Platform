import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, finalize, forkJoin, map, of, switchMap } from 'rxjs';

interface Quote {
  c: number;
  d: number;
  dp: number;
}

interface WatchlistItem {
  ticker: string;
  name?: string;
  quote?: Quote;
}

@Component({
  selector: 'app-watchlist',
  templateUrl: './watchlist.component.html',
  styleUrls: ['./watchlist.component.css'],
})
export class WatchlistComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  readonly removing = new Set<string>();
  watchlist: WatchlistItem[] = [];
  loading = false;
  loadError = '';
  actionError = '';
  actionStatus = '';

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadWatchlist();
  }

  loadWatchlist(): void {
    if (this.loading || this.removing.size) return;
    this.loading = true;
    this.loadError = '';
    this.http.get<WatchlistItem[]>('/api/watchlist').pipe(
      switchMap(items => items.length ? forkJoin(items.map(({ ticker }) => {
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
          quote: quote && Number.isFinite(quote.c) && quote.c > 0 ? quote : undefined,
        })));
      })) : of([])),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading = false),
    ).subscribe({
      next: items => this.watchlist = items,
      error: () => this.loadError = 'We couldn’t load your watchlist. Try again in a moment.',
    });
  }

  removeStock(ticker: string): void {
    if (this.loading || this.removing.has(ticker)) return;
    this.actionError = '';
    this.actionStatus = '';
    this.removing.add(ticker);
    this.http.delete(`/api/watchlist/${encodeURIComponent(ticker)}`).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.removing.delete(ticker)),
    ).subscribe({
      next: () => {
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
