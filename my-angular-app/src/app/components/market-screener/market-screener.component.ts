import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { retryPublicReadOnce } from '../../services/market-refresh';

interface ScreenerRow {
  symbol: string;
  close: number;
  change: number | null;
  volume: number | null;
}

interface ScreenerSnapshot {
  session: string;
  previousSession: string | null;
  previousUnavailable: boolean;
  stale: boolean;
  coverage: { reported: number; screened: number; comparable: number };
  rows: ScreenerRow[];
}

const initialFilters = { symbol: '', minimumClose: '', maximumClose: '', minimumChange: '', minimumVolume: '' };
type FilterName = keyof typeof initialFilters;
type SortField = keyof ScreenerRow;

const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const smallPrice = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
});
const signedPercent = new Intl.NumberFormat('en-US', {
  style: 'percent', signDisplay: 'exceptZero', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const tickerOrder = new Intl.Collator('en-US', { sensitivity: 'base', numeric: true });

function optionalNumber(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

@Component({
  selector: 'app-market-screener',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  templateUrl: './market-screener.component.html',
  styleUrl: './market-screener.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarketScreenerComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly resultsHeading = viewChild<ElementRef<HTMLElement>>('resultsHeading');

  readonly snapshot = signal<ScreenerSnapshot | null>(null);
  readonly loading = signal(false);
  readonly retryWait = signal(0);
  readonly error = signal('');
  readonly filters = signal(initialFilters);
  readonly order = signal<{ field: SortField; direction: 'ascending' | 'descending' }>({
    field: 'volume', direction: 'descending',
  });
  readonly pageSize = 20;
  readonly page = signal(0);
  readonly sortColumns: { field: SortField; label: string; title: string }[] = [
    { field: 'symbol', label: 'Symbol', title: 'Ticker symbol' },
    { field: 'close', label: 'Close', title: 'Closing price in USD' },
    { field: 'change', label: '1D change', title: 'Change versus the prior session close' },
    { field: 'volume', label: 'Volume', title: 'Reported share volume' },
  ];

  private readonly thresholds = computed(() => {
    const filters = this.filters();
    return {
      symbol: filters.symbol.trim().toUpperCase(),
      min: optionalNumber(filters.minimumClose),
      max: optionalNumber(filters.maximumClose),
      change: optionalNumber(filters.minimumChange),
      volume: optionalNumber(filters.minimumVolume),
    };
  });

  readonly filterError = computed(() => {
    const { min, max, change, volume } = this.thresholds();
    if ([min, max, change, volume].some(value => value !== null && !Number.isFinite(value))) {
      return 'Enter a valid number for each threshold.';
    }
    if ((min ?? 0) < 0 || (max ?? 0) < 0 || (volume ?? 0) < 0) {
      return 'Close and volume thresholds must be zero or greater.';
    }
    if (min !== null && max !== null && max < min) return 'Maximum close must be at least the minimum close.';
    return '';
  });

  readonly sortedRows = computed(() => {
    const { field, direction } = this.order();
    const sign = direction === 'ascending' ? 1 : -1;
    return [...(this.snapshot()?.rows ?? [])].sort((a, b) => {
      const byTicker = tickerOrder.compare(a.symbol, b.symbol);
      if (field === 'symbol') return byTicker * sign;
      const left = a[field];
      const right = b[field];
      if (left === null) return right === null ? byTicker : 1;
      if (right === null) return -1;
      return (left - right) * sign || byTicker;
    });
  });

  readonly matched = computed(() => {
    if (this.filterError()) return [];
    const { symbol, min, max, change, volume } = this.thresholds();
    return this.sortedRows().filter(row =>
      (!symbol || row.symbol.toUpperCase().includes(symbol))
      && (min === null || row.close >= min)
      && (max === null || row.close <= max)
      && (change === null || (row.change !== null && row.change >= change))
      && (volume === null || (row.volume !== null && row.volume >= volume)));
  });

  readonly pageCount = computed(() => Math.ceil(this.matched().length / this.pageSize));
  readonly visible = computed(() => {
    const start = this.page() * this.pageSize;
    return this.matched().slice(start, start + this.pageSize);
  });

  constructor() {
    this.load();
  }

  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.retryWait.set(0);
    this.error.set('');
    this.http.get<ScreenerSnapshot>('/api/market-screener').pipe(
      retryPublicReadOnce(seconds => this.retryWait.set(seconds)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: snapshot => {
        this.snapshot.set(snapshot);
        this.page.set(Math.min(this.page(), Math.max(0, this.pageCount() - 1)));
        this.loading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(error.status === 503
          ? 'Market data is temporarily unavailable. Please try again shortly.'
          : 'The latest market session could not be loaded. Please try again.');
      },
    });
  }

  filter(name: FilterName, value: string): void {
    this.filters.update(filters => ({ ...filters, [name]: value }));
    this.page.set(0);
  }

  clearFilters(): void {
    this.filters.set(initialFilters);
    this.page.set(0);
  }

  sort(field: SortField): void {
    const previous = this.order();
    const direction = previous.field === field
      ? previous.direction === 'ascending' ? 'descending' : 'ascending'
      : field === 'symbol' ? 'ascending' : 'descending';
    this.order.set({ field, direction });
    this.page.set(0);
  }

  changePage(offset: number): void {
    this.page.update(page => Math.min(Math.max(0, this.pageCount() - 1), Math.max(0, page + offset)));
    const heading = this.resultsHeading()?.nativeElement;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }

  formatPrice(value: number): string {
    if (value < .0001) return '< $0.0001';
    return (value < 1 ? smallPrice : price).format(value);
  }

  formatChange(value: number): string {
    return signedPercent.format(value / 100);
  }
}
