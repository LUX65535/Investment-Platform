import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { MarketBar, MarketHistoryService, utcDayMonthsBefore } from '../../services/market-history.service';

interface FeaturedSeries {
  start: number;
  end: number;
  close: number;
  change: number;
  line: string;
  area: string;
  lastY: number;
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
  loading = false;
  featured: FeaturedSeries | null = null;

  readonly examples = [
    { ticker: 'AAPL', name: 'Apple' },
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
    this.history.daily('AAPL').pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading = false),
    ).subscribe({
      next: ({ results }) => this.featured = this.summarize(results),
      error: () => this.featured = null,
    });
  }

  private summarize(bars: MarketBar[]): FeaturedSeries | null {
    const end = bars.at(-1);
    if (!end) return null;
    const cutoff = utcDayMonthsBefore(end.t, 3);
    const period = bars.filter(bar => bar.t >= cutoff);
    const start = period[0];
    if (period.length < 2 || end.t <= start.t) return null;

    const prices = period.map(bar => bar.c);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const y = (price: number) => high === low ? 64 : 111 - 98 * (price - low) / (high - low);
    const line = period.map((bar, index) => {
      const x = 8 + 344 * (bar.t - start.t) / (end.t - start.t);
      return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y(bar.c).toFixed(1)}`;
    }).join(' ');
    return {
      start: start.t,
      end: end.t,
      close: end.c,
      change: (end.c / start.c - 1) * 100,
      line,
      area: line + ' L352 124 L8 124 Z',
      lastY: y(end.c),
    };
  }
}