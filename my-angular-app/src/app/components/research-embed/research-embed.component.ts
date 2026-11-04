import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import * as Highcharts from 'highcharts/highstock';
import { HighchartsChartModule } from 'highcharts-angular';
import { catchError, distinctUntilChanged, map, merge, of, Subject, switchMap } from 'rxjs';

interface Quote {
  c: number;
  d: number | null;
  dp: number | null;
  t: number;
}

interface DailyPrice {
  t: number;
  c: number;
}

const defaultTicker = 'AAPL';
const tickerPattern = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?$/;
const quoteTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
  timeZoneName: 'short',
});

const chartRanges = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
] as const;

type ChartRange = typeof chartRanges[number];

@Component({
  selector: 'app-research-embed',
  standalone: true,
  imports: [CommonModule, FormsModule, HighchartsChartModule],
  templateUrl: './research-embed.component.html',
  styleUrls: ['./research-embed.component.css'],
})
export class ResearchEmbedComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly requests = new Subject<string>();

  readonly highcharts = Highcharts;
  readonly exampleTickers = ['AAPL', 'MSFT', 'NVDA'];
  readonly ranges = chartRanges;
  ticker = defaultTicker;
  tickerInput = defaultTicker;
  inputError = '';
  quote: Quote | null = null;
  history: DailyPrice[] = [];
  quoteLoading = true;
  historyLoading = true;
  activeRange: ChartRange = chartRanges[1];
  chartOptions: Highcharts.Options = {};
  chartPoints = 0;

  get quoteTime(): string {
    return this.quote ? quoteTimeFormat.format(this.quote.t * 1000) : '';
  }

  ngOnInit(): void {
    this.requests.pipe(
      switchMap(symbol => merge(
        this.http.get<Quote>('/company_quote', { params: { symbol } }).pipe(
          map(quote => ({
            quote: quote && Number.isFinite(quote.c) && quote.c > 0
              && Number.isFinite(new Date(quote.t * 1000).getTime()) && quote.t > 0
              ? {
                ...quote,
                d: Number.isFinite(quote.d) ? quote.d : null,
                dp: Number.isFinite(quote.dp) ? quote.dp : null,
              } : null,
          })),
          catchError(() => of({ quote: null })),
        ),
        this.http.get<{ results?: DailyPrice[] }>('/company_data', { params: { symbol } }).pipe(
          map(response => ({
            history: (Array.isArray(response?.results) ? response.results : [])
              .filter(point => Number.isFinite(point?.t) && point.t > 0 && Number.isFinite(point.c) && point.c > 0)
              .sort((first, second) => first.t - second.t),
          })),
          catchError(() => of({ history: [] })),
        ),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(result => {
      if ('quote' in result) {
        this.quote = result.quote;
        this.quoteLoading = false;
      } else {
        this.history = result.history;
        this.historyLoading = false;
        this.setRange(this.activeRange);
      }
    });

    this.route.queryParamMap.pipe(
      map(params => params.get('ticker')?.trim().toUpperCase() || defaultTicker),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(symbol => {
      this.inputError = '';
      if (!tickerPattern.test(symbol)) {
        this.inputError = 'This link has an invalid U.S. ticker. Showing AAPL.';
        symbol = defaultTicker;
      }
      this.tickerInput = symbol;
      this.load(symbol);
    });
  }

  selectTicker(value: string): void {
    const symbol = value.trim().toUpperCase();
    if (!tickerPattern.test(symbol)) {
      this.inputError = 'Enter a U.S. stock symbol, such as AAPL or BRK.B.';
      return;
    }

    this.inputError = '';
    this.tickerInput = symbol;
    if (symbol === this.ticker) {
      this.load(symbol);
    } else {
      void this.router.navigate([], { relativeTo: this.route, queryParams: { ticker: symbol } });
    }
  }

  refresh(): void {
    this.load(this.ticker);
  }

  setRange(range: ChartRange): void {
    this.activeRange = range;
    const latest = this.history.at(-1)?.t ?? 0;
    const start = latest - range.days * 86400000;
    const data = this.history.filter(point => point.t >= start).map(point => [point.t, point.c]);
    this.chartPoints = data.length;
    this.chartOptions = {
      chart: { type: 'area', backgroundColor: 'transparent', spacing: [12, 6, 5, 6], animation: false },
      title: { text: undefined },
      credits: { enabled: false },
      legend: { enabled: false },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 95,
        lineColor: '#dce4f0',
        labels: { style: { color: '#53637d' } },
      },
      yAxis: {
        title: { text: undefined },
        gridLineColor: '#e8edf5',
        labels: { style: { color: '#53637d' }, format: '${value}' },
      },
      tooltip: { valueDecimals: 2, valuePrefix: '$' },
      plotOptions: { series: { animation: false, marker: { enabled: false } } },
      series: [{
        type: 'area',
        name: this.ticker + ' close',
        color: '#315ad3',
        fillColor: '#ebf0ff',
        threshold: null,
        data,
      }],
    };
  }

  private load(symbol: string): void {
    this.ticker = symbol;
    this.quote = null;
    this.history = [];
    this.quoteLoading = true;
    this.historyLoading = true;
    this.requests.next(symbol);
  }
}
