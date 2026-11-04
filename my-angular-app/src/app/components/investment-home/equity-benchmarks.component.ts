import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { MarketHistoryService } from '../../services/market-history.service';
import { dailyRefreshes } from '../../services/market-refresh';
import { BenchmarkClose, describeClose, distinctDailyCloses } from './benchmark-data';

interface BenchmarkRow {
  symbol: string;
  exposure: string;
  close: BenchmarkClose | null;
  state: 'loading' | 'ready' | 'unavailable';
}

@Component({
  selector: 'app-equity-benchmarks',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="benchmarks" aria-labelledby="equity-benchmarks-title">
      <header>
        <div>
          <h2 id="equity-benchmarks-title">Equity benchmarks</h2>
          <p>Three ETFs tracking different parts of the U.S. equity market.</p>
        </div>
        <span>Daily closes · USD</span>
      </header>
      <table aria-labelledby="equity-benchmarks-title">
        <thead>
          <tr><th scope="col">ETF</th><th scope="col">Last close</th><th scope="col">Close change</th></tr>
        </thead>
        <tbody>
          <tr *ngFor="let row of rows">
            <th scope="row"><strong>{{ row.symbol }}</strong><small>{{ row.exposure }}</small></th>
            <ng-container *ngIf="row.close as quote; else missingClose">
              <td><strong>{{ quote.close | currency:'USD' }}</strong>
                <time [attr.datetime]="quote.date | date:'yyyy-MM-dd':'+0000'">{{ quote.date | date:'MMM d, yyyy':'+0000' }}</time>
                <small *ngIf="row.state === 'unavailable'">Last available</small>
              </td>
              <td [class.positive]="quote.change !== null && quote.change > 0"
                  [class.negative]="quote.change !== null && quote.change < 0">
                <strong *ngIf="quote.change !== null; else missingChange">
                  {{ quote.change > 0 ? '+' : '' }}{{ quote.change | number:'1.2-2' }}%
                </strong>
              </td>
            </ng-container>
            <ng-template #missingClose>
              <td class="missing" colspan="2">
                <span role="status">{{ row.state === 'loading' ? 'Loading daily close…' : 'Daily close unavailable' }}</span>
              </td>
            </ng-template>
          </tr>
        </tbody>
      </table>
      <footer>
        Massive (Polygon) · Change from the previous available close
        <button *ngIf="canRetry" type="button" class="state-action" (click)="loadBenchmarks(true)">Retry unavailable prices</button>
      </footer>
    </section>
    <ng-template #missingChange><span aria-label="Previous close unavailable">—</span></ng-template>
  `,
  styles: [`
    :host { display: block; }
    .benchmarks {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: .22rem .8rem;
      padding: .75rem 1rem;
    }
    h2 { margin: 0; color: var(--ink); font-size: .96rem; font-weight: 680; }
    p { margin: .18rem 0 0; }
    header span, p, time, footer { color: var(--muted); font-size: .74rem; }
    table { width: 100%; border-collapse: collapse; font-size: .83rem; font-variant-numeric: tabular-nums; }
    :is(th, td) { padding: .38rem 1rem; border-top: 1px solid var(--line); text-align: end; }
    th:first-child { text-align: start; }
    thead { background: var(--surface-subtle); color: var(--muted); }
    thead th, strong { font-weight: 650; }
    tbody th { width: 54%; color: var(--ink); }
    tbody th strong { display: inline-block; width: 3rem; }
    small { color: var(--muted); font-size: .78rem; font-weight: 500; }
    time { display: block; }
    .missing { color: var(--muted); }
    .positive { color: var(--positive); }
    .negative { color: var(--negative); }
    footer { border-top: 1px solid var(--line); padding: .55rem 1rem; }
    @media (max-width: 520px) {
      :is(th, td), header, footer { padding-inline: .8rem; }
      tbody th { width: auto; }
      tbody th strong { display: block; width: auto; }
      small { font-size: .72rem; }
    }
  `],
})
export class EquityBenchmarksComponent implements OnInit {
  private readonly history = inject(MarketHistoryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly loading = new Set<string>();
  readonly rows: BenchmarkRow[] = [
    { symbol: 'SPY', exposure: 'S&P 500', close: null, state: 'unavailable' },
    { symbol: 'QQQ', exposure: 'Nasdaq-100', close: null, state: 'loading' },
    { symbol: 'IWM', exposure: 'U.S. small caps', close: null, state: 'loading' },
  ];

  @Input({ required: true }) set spy(quote: BenchmarkClose | null) {
    this.rows[0].close = quote;
    this.rows[0].state = quote ? 'ready' : 'unavailable';
  }

  ngOnInit(): void {
    this.loadBenchmarks();
    dailyRefreshes(this.document).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.loadBenchmarks());
  }

  get canRetry(): boolean {
    return this.rows.slice(1).some(row => row.state === 'unavailable' && !this.loading.has(row.symbol));
  }

  loadBenchmarks(retry = false): void {
    for (const row of this.rows.slice(1)) {
      if (this.loading.has(row.symbol) || (retry && row.state !== 'unavailable')) continue;
      this.loading.add(row.symbol);
      if (!row.close) row.state = 'loading';
      this.history.daily(row.symbol).pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.loading.delete(row.symbol)),
      ).subscribe({
        next: ({ results }) => {
          const sessions = distinctDailyCloses(results);
          const latest = sessions.at(-1);
          if (latest) row.close = describeClose(latest, sessions.at(-2));
          row.state = latest ? 'ready' : 'unavailable';
        },
        error: () => row.state = 'unavailable',
      });
    }
  }
}
