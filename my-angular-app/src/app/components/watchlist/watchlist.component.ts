import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, ElementRef, Injectable, OnInit, ViewChild, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import { catchError, finalize, forkJoin, from, map, mergeMap, of, switchMap, tap } from 'rxjs';
import { PortfolioService } from '../../services/portfolio.service';
import { MarketQuote, MarketQuoteService, listQuoteRefreshMs, quoteBatchLimit } from '../../services/market-quote.service';
import { activeRefreshes, visibleQuoteSymbols } from '../../services/market-refresh';

interface WatchQuote {
  price: number;
  change: number | null;
  changePercent: number | null;
  low: number | null;
  high: number | null;
  open: number | null;
  previousClose: number | null;
  rangePosition: number | null;
}

type SortKey = 'symbol' | 'price' | 'change' | 'changePercent';

interface WatchlistItem {
  ticker: string;
  name?: string;
  currency?: string;
  quote?: WatchQuote;
  quotedAt?: number;
  quotePending?: boolean;
  priorQuote?: boolean;
}

const olderThanMs = 24 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
class WatchlistMarketCache {
  readonly entries = new Map<string, WatchlistItem>();

  remember(item: WatchlistItem): void {
    this.entries.delete(item.ticker);
    this.entries.set(item.ticker, item);
    if (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!);
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positivePrice(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function parseQuote(response: MarketQuote | null): WatchQuote | undefined {
  if (!response) return undefined;
  const price = positivePrice(response.c);
  if (price === null) return undefined;
  const low = positivePrice(response.l);
  const high = positivePrice(response.h);
  const inverted = low !== null && high !== null && low > high;
  const rangePosition = low !== null && high !== null && price >= low && price <= high
    ? (high === low ? 50 : (price - low) / (high - low) * 100) : null;
  return {
    price,
    change: finiteNumber(response.d),
    changePercent: finiteNumber(response.dp),
    low: inverted ? null : low,
    high: inverted ? null : high,
    open: positivePrice(response.o),
    previousClose: positivePrice(response.pc),
    rangePosition,
  };
}

@Component({
  selector: 'app-watchlist',
  standalone: true,
  imports: [CommonModule, FormsModule, MatProgressSpinnerModule, RouterLink],
  templateUrl: './watchlist.component.html',
  styleUrls: ['./watchlist.component.css'],
})
export class WatchlistComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly marketCache = inject(WatchlistMarketCache);
  private readonly marketQuotes = inject(MarketQuoteService);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  @ViewChild('listTitle', { static: true }) private listTitle!: ElementRef<HTMLElement>;
  readonly removing = new Set<string>();
  readonly mobileSortOptions: readonly { key: SortKey; ascending: boolean; label: string }[] = [
    { key: 'symbol', ascending: true, label: 'Symbol A–Z' },
    { key: 'symbol', ascending: false, label: 'Symbol Z–A' },
    { key: 'price', ascending: false, label: 'Price high to low' },
    { key: 'price', ascending: true, label: 'Price low to high' },
    { key: 'changePercent', ascending: false, label: 'Day % high to low' },
    { key: 'changePercent', ascending: true, label: 'Day % low to high' },
    { key: 'change', ascending: false, label: 'Day amount high to low' },
    { key: 'change', ascending: true, label: 'Day amount low to high' },
  ];
  watchlist: WatchlistItem[] = [];
  sortKey: SortKey = 'symbol';
  ascending = true;
  filter = '';
  editing = false;
  loading = false;
  hasLoaded = false;
  lastRemoved?: WatchlistItem;
  restoring = false;
  private enriching = false;
  loadError = '';
  actionError = '';
  actionStatus = '';

  constructor(private http: HttpClient, private portfolioService: PortfolioService) {}

  ngOnInit(): void {
    this.loadWatchlist();
    activeRefreshes(this.document, listQuoteRefreshMs).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshVisibleQuotes());
  }

  get sortedWatchlist(): WatchlistItem[] {
    const term = this.filter.trim().toLowerCase();
    const direction = this.ascending ? 1 : -1;
    return this.watchlist.filter(item => item.ticker.toLowerCase().includes(term) || item.name?.toLowerCase().includes(term))
      .sort((first, second) => {
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

  get mobileSortIndex(): number {
    return this.mobileSortOptions.findIndex(option => option.key === this.sortKey && option.ascending === this.ascending);
  }

  setMobileSort(index: number): void {
    const option = this.mobileSortOptions[index];
    if (!option) return;
    this.sortKey = option.key;
    this.ascending = option.ascending;
  }

  private sortValue(item: WatchlistItem): number | null {
    if (!item.quote) return null;
    if (this.sortKey === 'price') return item.quote.price;
    return this.sortKey === 'change' ? item.quote.change : item.quote.changePercent;
  }

  get quotedCount(): number {
    return this.watchlist.filter(item => item.quote).length;
  }

  get quotesPending(): boolean {
    return this.watchlist.some(item => item.quotePending);
  }

  get quoteSummary(): { eligible: number; advancing: number; declining: number; unchanged: number; largest?: { ticker: string; percent: number } } {
    const oldestEligible = Date.now() - olderThanMs;
    let advancing = 0;
    let declining = 0;
    let unchanged = 0;
    let largest: { ticker: string; percent: number } | undefined;
    for (const item of this.watchlist) {
      const change = item.quote?.changePercent;
      if (change == null || !item.quotedAt || item.quotedAt < oldestEligible || item.priorQuote) continue;
      if (change > 0) advancing++;
      else if (change < 0) declining++;
      else unchanged++;
      if (Math.abs(change) > Math.abs(largest?.percent ?? 0)) largest = { ticker: item.ticker, percent: change };
    }
    return { eligible: advancing + declining + unchanged, advancing, declining, unchanged, largest };
  }

  get unavailableCount(): number {
    return this.watchlist.length - this.quotedCount;
  }

  get priorQuoteCount(): number {
    return this.watchlist.filter(item => item.priorQuote).length;
  }

  get canEdit(): boolean {
    return !this.loading && !this.restoring && this.removing.size === 0;
  }

  get canRefresh(): boolean {
    return this.canEdit && !this.enriching;
  }

  quoteState(item: WatchlistItem): string {
    if (item.priorQuote) return 'Previous quote';
    return item.quotedAt && Date.now() - item.quotedAt > olderThanMs ? 'Older than 24h' : '';
  }

  loadWatchlist(): void {
    if (!this.canRefresh) return;
    const previous = new Map(this.watchlist.map(item => [item.ticker, item]));
    this.loading = true;
    this.loadError = '';
    this.portfolioService.getWatchlist().pipe(
      tap(items => {
        this.watchlist = items.map(({ ticker }) => {
          const known = previous.get(ticker) ?? this.marketCache.entries.get(ticker);
          if (known) previous.set(ticker, known);
          return { ...known, ticker, quotePending: true };
        });
        this.hasLoaded = true;
        this.loading = false;
        this.enriching = items.length > 0;
      }),
      switchMap(items => from(items).pipe(mergeMap(({ ticker }) => this.enrich(ticker, previous.get(ticker), true), 3))),
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

  get quoteRecoveryNeeded(): boolean {
    return !this.enriching && this.watchlist.some(item => !item.quote || item.priorQuote);
  }

  refreshVisibleQuotes(retry = false): void {
    if (!this.canRefresh || this.editing || this.document.hidden || this.document.defaultView?.navigator.onLine === false) return;
    const visible = new Set(visibleQuoteSymbols(this.host.nativeElement, quoteBatchLimit));
    const targets = this.watchlist.filter(item => retry ? !item.quote || item.priorQuote : visible.has(item.ticker))
      .slice(0, quoteBatchLimit);
    if (!targets.length) return;
    const requested = new Set(targets.map(item => item.ticker));
    this.enriching = true;
    this.watchlist = this.watchlist.map(item => requested.has(item.ticker) ? { ...item, quotePending: true } : item);
    from(targets).pipe(
      mergeMap(item => this.enrich(item.ticker, item, false), 3),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.enriching = false),
    ).subscribe(enriched => this.watchlist = this.watchlist.map(item => item.ticker === enriched.ticker ? enriched : item));
  }

  private enrich(ticker: string, known: WatchlistItem | undefined, loadProfile: boolean) {
    const needsProfile = loadProfile && !(known?.name && known.currency);
    return forkJoin({
      profile: needsProfile ? this.http.get<{ name?: string; currency?: string }>('/company_profile', { params: { symbol: ticker } })
        .pipe(catchError(() => of(null))) : of(known),
      snapshot: this.marketQuotes.read(ticker),
    }).pipe(map(({ profile, snapshot }): WatchlistItem => {
      const quote = snapshot.quote;
      const quotedAt = quote ? quote.t * 1000 : undefined;
      const usePrevious = Boolean(known?.quote && (!quote || (known.quotedAt && quote.t * 1000 < known.quotedAt)));
      const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
      return {
        ticker,
        name: name || known?.name,
        currency: typeof profile?.currency === 'string' && /^[A-Z]{3}$/.test(profile.currency) ? profile.currency : known?.currency,
        quotedAt: usePrevious ? known?.quotedAt : quotedAt,
        quote: usePrevious ? known?.quote : parseQuote(quote),
        priorQuote: snapshot.previous || usePrevious,
      };
    }), tap(item => this.marketCache.remember(item)));
  }

  removeStock(ticker: string, button: HTMLButtonElement): void {
    const item = this.watchlist.find(row => row.ticker === ticker);
    if (!this.canEdit || !this.editing || !item) return;
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
        this.lastRemoved = item;
        if (!this.watchlist.length) this.editing = false;
        this.actionStatus = `${ticker} removed from your watchlist.`;
      },
      error: () => this.actionError = `Couldn’t remove ${ticker}. Please try again.`,
    });
  }

  undoRemove(button: HTMLButtonElement): void {
    const item = this.lastRemoved;
    if (!this.canEdit || !item) return;
    this.restoring = true;
    this.actionError = '';
    this.portfolioService.addWatchlist(item.ticker).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.restoring = false),
    ).subscribe({
      next: () => {
        if (button.ownerDocument.activeElement === button) this.listTitle.nativeElement.focus({ preventScroll: true });
        if (!this.watchlist.some(row => row.ticker === item.ticker)) this.watchlist = [...this.watchlist, item];
        this.lastRemoved = undefined;
        this.actionStatus = `${item.ticker} restored to your watchlist.`;
      },
      error: () => this.actionError = `Couldn’t restore ${item.ticker}. Please try again.`,
    });
  }

  trackByTicker(_index: number, item: WatchlistItem): string {
    return item.ticker;
  }
}
