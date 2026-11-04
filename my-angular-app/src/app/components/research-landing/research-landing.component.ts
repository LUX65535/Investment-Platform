import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import { MarketBar, MarketHistoryService, utcDayMonthsBefore } from '../../services/market-history.service';
import { dailyRefreshes } from '../../services/market-refresh';
import { ResearchRecentsService } from '../../services/research-recents.service';

const featuredRanges = ['1M', '3M', '1Y'] as const;
type FeaturedRange = typeof featuredRanges[number];
const monthsInRange: Record<FeaturedRange, number> = { '1M': 1, '3M': 3, '1Y': 12 };
const plotWidth = 360;
const dayMs = 86_400_000;

interface ResearchSession {
  date: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  previousCloseChangePercent: number | null;
}

interface ResearchIntervalSummary {
  startClose: number;
  priceReturnPercent: number | null;
  sessionCount: number;
  highestHigh: number | null;
  highSessionCount: number;
  lowestLow: number | null;
  lowSessionCount: number;
  averageVolume: number | null;
  volumeSessionCount: number;
}

interface FeaturedPoint {
  time: number;
  close: number;
  x: number;
  y: number;
}

interface FeaturedSeries {
  start: number;
  end: number;
  line: string;
  area: string;
  points: FeaturedPoint[];
  ticks: { price: number; position: number }[];
}

@Component({
  standalone: true,
  selector: 'app-research-landing',
  imports: [CommonModule, RouterLink],
  templateUrl: './research-landing.component.html',
  styleUrls: ['./research-landing.component.css', './research-landing-sessions.css'],
})
export class ResearchLandingComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly history = inject(MarketHistoryService);
  private sessions: ResearchSession[] = [];
  private featuredRequest?: Subscription;
  loading = false;
  requestFailed = false;
  featured: FeaturedSeries | null = null;
  recentSessions: ResearchSession[] = [];
  intervalSummary: ResearchIntervalSummary | null = null;
  readonly ranges = featuredRanges;
  readonly recentSymbols = inject(ResearchRecentsService).symbols;
  range: FeaturedRange = '3M';
  pointIndex = 0;

  readonly examples = [
    { ticker: 'AAPL', name: 'Apple Inc.', shortName: 'Apple' },
    { ticker: 'MSFT', name: 'Microsoft Corporation', shortName: 'Microsoft' },
    { ticker: 'NVDA', name: 'NVIDIA Corporation', shortName: 'NVIDIA' },
    { ticker: 'AMZN', name: 'Amazon.com, Inc.', shortName: 'Amazon' },
  ];
  instrument = this.examples[0];

  get activePoint(): FeaturedPoint | undefined {
    return this.featured?.points[this.pointIndex];
  }

  get inspectedPoint(): FeaturedPoint | undefined {
    return this.pointIndex === (this.featured?.points.length ?? 0) - 1 ? undefined : this.activePoint;
  }

  get canSelectRange(): boolean {
    return this.sessions.length > 1;
  }

  ngOnInit(): void {
    this.loadFeatured();
    dailyRefreshes(this.document).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.loadFeatured());
  }

  selectInstrument(instrument: typeof this.instrument): void {
    if (instrument === this.instrument) return;
    this.featuredRequest?.unsubscribe();
    this.instrument = instrument;
    this.setBars([]);
    this.loadFeatured();
  }

  loadFeatured(): void {
    if (this.loading) return;
    this.loading = true;
    this.requestFailed = false;
    this.featuredRequest = this.history.daily(this.instrument.ticker).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading = false),
    ).subscribe({
      next: ({ results }) => {
        if (results.length || !this.recentSessions.length) this.setBars(results);
        else this.requestFailed = true;
      },
      error: () => this.requestFailed = true,
    });
  }

  selectRange(range: FeaturedRange): void {
    if (this.range === range) return;
    this.range = range;
    this.updateFeatured();
  }

  inspectPoint(event: Event): void {
    this.pointIndex = (event.target as HTMLInputElement).valueAsNumber;
  }

  inspectPointer(event: PointerEvent): void {
    const points = this.featured?.points;
    if (!points?.length) return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * plotWidth;
    const next = points.findIndex(point => point.x >= x);
    if (next < 0) this.pointIndex = points.length - 1;
    else if (next === 0) this.pointIndex = 0;
    else this.pointIndex = x - points[next - 1].x <= points[next].x - x ? next - 1 : next;
  }

  private setBars(bars: MarketBar[]): void {
    const sessionsByDay = new Map<number, MarketBar>();
    for (const bar of bars) {
      if (!Number.isSafeInteger(bar.t) || bar.t <= 0 || !Number.isFinite(new Date(bar.t).getTime())
        || !Number.isFinite(bar.c) || bar.c <= 0) continue;
      const day = Math.floor(bar.t / dayMs);
      const previous = sessionsByDay.get(day);
      if (!previous || previous.t <= bar.t) sessionsByDay.set(day, bar);
    }

    const sorted = Array.from(sessionsByDay.values()).sort((a, b) => a.t - b.t);
    this.sessions = sorted.map((bar, index) => {
      const previous = sorted[index - 1];
      const open = Number.isFinite(bar.o) && bar.o > 0 ? bar.o : null;
      return {
        date: bar.t,
        open,
        high: Number.isFinite(bar.h) && bar.h >= Math.max(bar.c, open ?? bar.c) ? bar.h : null,
        low: Number.isFinite(bar.l) && bar.l > 0 && bar.l <= Math.min(bar.c, open ?? bar.c) ? bar.l : null,
        close: bar.c,
        volume: Number.isFinite(bar.v) && bar.v >= 0 && bar.v <= Number.MAX_SAFE_INTEGER ? bar.v : null,
        previousCloseChangePercent: previous ? this.priceReturn(bar.c, previous.c) : null,
      };
    });
    this.recentSessions = this.sessions.slice(-5).reverse();
    this.updateFeatured();
  }

  private priceReturn(close: number, start: number): number | null {
    const value = (close / start - 1) * 100;
    return Number.isFinite(value) ? value : null;
  }

  private updateFeatured(): void {
    const last = this.sessions.at(-1);
    const cutoff = last ? utcDayMonthsBefore(last.date, monthsInRange[this.range]) : 0;
    const period = this.sessions.filter(session => session.date >= cutoff);
    this.intervalSummary = this.summarizeInterval(period);
    this.featured = this.buildChart(period, this.intervalSummary?.priceReturnPercent ?? null);
    this.pointIndex = this.featured ? this.featured.points.length - 1 : 0;
  }

  private summarizeInterval(period: ResearchSession[]): ResearchIntervalSummary | null {
    const start = period[0];
    const end = period.at(-1);
    if (!start || !end) return null;

    const highs = period.map(session => session.high).filter((value): value is number => value !== null);
    const lows = period.map(session => session.low).filter((value): value is number => value !== null);
    const volumes = period.map(session => session.volume).filter((value): value is number => value !== null);
    return {
      startClose: start.close,
      priceReturnPercent: period.length > 1 ? this.priceReturn(end.close, start.close) : null,
      sessionCount: period.length,
      highestHigh: highs.length ? Math.max(...highs) : null,
      highSessionCount: highs.length,
      lowestLow: lows.length ? Math.min(...lows) : null,
      lowSessionCount: lows.length,
      averageVolume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) / volumes.length : null,
      volumeSessionCount: volumes.length,
    };
  }

  private buildChart(period: ResearchSession[], priceReturnPercent: number | null): FeaturedSeries | null {
    const start = period[0];
    const end = period.at(-1);
    if (!start || !end || priceReturnPercent === null) return null;

    const prices = period.map(session => session.close);
    const lowestClose = Math.min(...prices);
    const highestClose = Math.max(...prices);
    const flat = highestClose === lowestClose;
    const low = flat ? lowestClose * .98 : lowestClose;
    const high = flat ? highestClose * 1.02 : highestClose;
    const y = (price: number) => 111 - 98 * (price - low) / (high - low);
    const points = period.map(session => ({
      time: session.date,
      close: session.close,
      x: 8 + (plotWidth - 16) * (session.date - start.date) / (end.date - start.date),
      y: y(session.close),
    }));
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
    return {
      start: start.date,
      end: end.date,
      line,
      area: line + ' L352 124 L8 124 Z',
      points,
      ticks: [high, low + (high - low) / 2, low].map(price => ({ price, position: y(price) / 128 * 100 })),
    };
  }
}
