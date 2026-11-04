import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { MarketBar, MarketHistoryService, utcDayMonthsBefore } from '../../services/market-history.service';

const featuredRanges = ['1M', '3M', '1Y'] as const;
type FeaturedRange = typeof featuredRanges[number];
const monthsInRange: Record<FeaturedRange, number> = { '1M': 1, '3M': 3, '1Y': 12 };
const plotWidth = 360;

interface FeaturedPoint {
  time: number;
  close: number;
  x: number;
  y: number;
}

interface FeaturedSeries {
  start: number;
  end: number;
  close: number;
  session: { open: number; high: number; low: number; volume: number } | null;
  change: number;
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
  styleUrls: ['./research-landing.component.css'],
})
export class ResearchLandingComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly history = inject(MarketHistoryService);
  private bars: MarketBar[] = [];
  loading = false;
  requestFailed = false;
  featured: FeaturedSeries | null = null;
  readonly ranges = featuredRanges;
  range: FeaturedRange = '3M';
  pointIndex = 0;

  get activePoint(): FeaturedPoint | undefined {
    return this.featured?.points[this.pointIndex];
  }

  get canSelectRange(): boolean {
    return this.bars.length > 1;
  }

  readonly examples = [
    { ticker: 'MSFT', name: 'Microsoft' },
    { ticker: 'NVDA', name: 'NVIDIA' },
    { ticker: 'AMZN', name: 'Amazon' },
  ];

  ngOnInit(): void {
    this.loadFeatured();
  }

  loadFeatured(): void {
    if (this.loading) return;
    this.loading = true;
    this.requestFailed = false;
    this.history.daily('AAPL').pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading = false),
    ).subscribe({
      next: ({ results }) => {
        this.bars = results;
        this.updateFeatured();
      },
      error: () => {
        this.bars = [];
        this.updateFeatured();
        this.requestFailed = true;
      },
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

  private updateFeatured(): void {
    this.featured = this.summarize();
    this.pointIndex = this.featured ? this.featured.points.length - 1 : 0;
  }

  private summarize(): FeaturedSeries | null {
    const end = this.bars.at(-1);
    if (!end) return null;
    const cutoff = utcDayMonthsBefore(end.t, monthsInRange[this.range]);
    const period = this.bars.filter(bar => bar.t >= cutoff);
    const start = period[0];
    if (period.length < 2 || end.t <= start.t) return null;

    const prices = period.map(bar => bar.c);
    const lowestClose = Math.min(...prices);
    const highestClose = Math.max(...prices);
    const flat = highestClose === lowestClose;
    const low = flat ? lowestClose * .98 : lowestClose;
    const high = flat ? highestClose * 1.02 : highestClose;
    const y = (price: number) => 111 - 98 * (price - low) / (high - low);
    const points = period.map(bar => ({
      time: bar.t,
      close: bar.c,
      x: 8 + (plotWidth - 16) * (bar.t - start.t) / (end.t - start.t),
      y: y(bar.c),
    }));
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
    return {
      start: start.t,
      end: end.t,
      close: end.c,
      session: [end.o, end.h, end.l, end.v].every(value => Number.isFinite(value) && value > 0)
        ? { open: end.o, high: end.h, low: end.l, volume: end.v } : null,
      change: (end.c / start.c - 1) * 100,
      line,
      area: line + ' L352 124 L8 124 Z',
      points,
      ticks: [high, low + (high - low) / 2, low].map(price => ({ price, position: y(price) / 128 * 100 })),
    };
  }
}
