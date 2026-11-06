import { CommonModule, DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { MarketBar, MarketHistoryService, utcDayMonthsBefore } from '../../services/market-history.service';
import { ResearchRecentsService } from '../../services/research-recents.service';
import { BenchmarkClose, describeClose, distinctDailyCloses, millisecondsPerDay, priceReturn } from './benchmark-data';
import { EquityBenchmarksComponent } from './equity-benchmarks.component';
import { BenchmarkCandlesComponent } from './benchmark-candles.component';
import { MarketSectorMovesComponent, SectorMove } from './market-sector-moves.component';
import { dailyRefreshes, retryPublicReadOnce } from '../../services/market-refresh';

interface OverviewQuote {
  symbol: string;
  close: number;
  change: number | null;
  volume: number | null;
}

interface MarketOverview {
  session: string;
  previousSession: string | null;
  stale: boolean;
  screened: number;
  comparable: number;
  up: number;
  down: number;
  unchanged: number;
  benchmarks: OverviewQuote[];
  sectors: SectorMove[];
  active: OverviewQuote[];
}

interface BenchmarkSnapshot {
  date: number;
  close: number;
  returns: { label: string; value: number | null }[];
  bars: readonly MarketBar[];
  recentSessions: BenchmarkClose[];
}

@Component({
  selector: 'app-investment-home',
  standalone: true,
  imports: [CommonModule, RouterLink, EquityBenchmarksComponent, BenchmarkCandlesComponent, MarketSectorMovesComponent],
  templateUrl: './investment-home.component.html',
  styleUrls: ['./investment-home.component.css'],
})
export class InvestmentHomeComponent implements OnInit {
  private readonly history = inject(MarketHistoryService);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  readonly recentSymbols = inject(ResearchRecentsService).symbols;

  readonly benchmarkSymbols = ['SPY', 'QQQ', 'IWM'];
  benchmark: BenchmarkSnapshot | null = null;
  breadth: MarketOverview | null = null;
  closingNote = '';
  breadthLoading = false;
  breadthError = false;
  loading = false;
  failed = false;
  benchmarkWait = 0;
  breadthWait = 0;

  ngOnInit(): void {
    this.loadBenchmark();
    this.loadBreadth();
    dailyRefreshes(this.document).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.loadBenchmark();
      this.loadBreadth();
    });
  }

  loadBenchmark(): void {
    if (this.loading) return;
    this.loading = true;
    this.failed = false;
    this.benchmarkWait = 0;
    this.history.daily('SPY').pipe(
      retryPublicReadOnce(seconds => this.benchmarkWait = seconds),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading = false),
    ).subscribe({
      next: ({ results }) => {
        const snapshot = this.createSnapshot(results);
        if (snapshot || !this.benchmark) this.benchmark = snapshot;
        else this.failed = true;
      },
      error: () => this.failed = true,
    });
  }

  loadBreadth(): void {
    if (this.breadthLoading) return;
    this.breadthLoading = true;
    this.breadthError = false;
    this.breadthWait = 0;
    this.http.get<MarketOverview>('/api/market-overview').pipe(
      retryPublicReadOnce(seconds => this.breadthWait = seconds),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.breadthLoading = false),
    ).subscribe({
      next: overview => {
        this.breadth = overview;
        this.closingNote = this.describeClose(overview);
      },
      error: () => this.breadthError = true,
    });
  }

  benchmarkRow(symbol: string): OverviewQuote | undefined {
    return this.breadth?.benchmarks.find(row => row.symbol === symbol);
  }

  breadthPercent(count: number): number {
    return this.breadth?.comparable ? count / this.breadth.comparable * 100 : 0;
  }

  private describeClose(market: MarketOverview): string {
    const changes = this.benchmarkSymbols.map(symbol => market.benchmarks.find(row => row.symbol === symbol)?.change);
    const rose = changes.every(change => change != null && change >= .005);
    const fell = changes.every(change => change != null && change <= -.005);
    const benchmarks = rose ? 'All three benchmark ETFs rose' : fell ? 'All three benchmark ETFs fell' : '';

    if (!market.comparable) return benchmarks ? benchmarks + '.' : '';
    const { up, down } = market;
    // Use the directional count so a session with mostly unchanged closes cannot hide an imbalance.
    const nearEven = Math.abs(up - down) <= (up + down) * .05;
    const balance = !up && !down ? 'all comparable closes were unchanged'
      : nearEven ? 'advances and declines were nearly even'
      : up > down ? 'more securities rose than fell' : 'more securities fell than rose';
    if (!benchmarks) return balance[0].toUpperCase() + balance.slice(1) + '.';
    const contrary = nearEven || (rose ? down > up : up > down);
    return benchmarks + (contrary ? ', while ' : ', and ') + balance + '.';
  }

  private createSnapshot(bars: MarketBar[]): BenchmarkSnapshot | null {
    const sessions = distinctDailyCloses(bars);
    const latest = sessions.at(-1);
    if (!latest) return null;

    const monthCutoff = utcDayMonthsBefore(latest.t, 1);
    const month = sessions.filter(session => session.t >= monthCutoff);
    const monthlyStart = month.length > 1 ? month[0] : undefined;
    const coversMonth = monthlyStart && Math.floor((monthlyStart.t - monthCutoff) / millisecondsPerDay) <= 4;
    const recentStart = Math.max(0, sessions.length - 6);
    const recentSessions = sessions.slice(recentStart).map((session, index) =>
      describeClose(session, sessions[recentStart + index - 1]),
    ).reverse();
    return {
      date: latest.t,
      close: latest.c,
      returns: [
        { label: 'Latest session', value: priceReturn(latest, sessions.at(-2)) },
        { label: '5 sessions', value: priceReturn(latest, sessions.at(-6)) },
        { label: '1 month', value: coversMonth ? priceReturn(latest, monthlyStart) : null },
      ],
      bars: sessions,
      recentSessions,
    };
  }

}
