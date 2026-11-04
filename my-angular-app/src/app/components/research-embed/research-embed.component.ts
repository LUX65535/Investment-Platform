import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, ElementRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import * as Highcharts from 'highcharts/highstock';
import HighchartsAccessibility from 'highcharts/modules/accessibility';
import { HighchartsChartModule } from 'highcharts-angular';
import { catchError, distinctUntilChanged, map, of, Subject, switchMap } from 'rxjs';
import { MarketHistoryService } from '../../services/market-history.service';
import { MarketQuoteService, quoteRefreshMs } from '../../services/market-quote.service';
import { activeRefreshes, dailyRefreshes } from '../../services/market-refresh';

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
  { label: '1M', description: '1 month', days: 30 },
  { label: '3M', description: '3 months', days: 90 },
  { label: '1Y', description: '1 year', days: 365 },
] as const;

type ChartRange = typeof chartRanges[number];

HighchartsAccessibility(Highcharts);

@Component({
  selector: 'app-research-embed',
  standalone: true,
  imports: [CommonModule, FormsModule, HighchartsChartModule],
  templateUrl: './research-embed.component.html',
  styleUrls: ['./research-embed.component.css'],
})
export class ResearchEmbedComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly marketQuotes = inject(MarketQuoteService);
  private readonly marketHistory = inject(MarketHistoryService);
  private readonly quoteRequests = new Subject<string>();
  private readonly historyRequests = new Subject<string>();
  private embeddedVisible = true;

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
  quoteFailed = false;
  quotePrevious = false;
  historyFailed = false;
  activeRange: ChartRange = chartRanges[1];
  chartOptions: Highcharts.Options = {};
  chartPoints = 0;
  historyReturn: number | null = null;

  get quoteTime(): string {
    return this.quote ? quoteTimeFormat.format(this.quote.t * 1000) : '';
  }

  get quoteIsoTime(): string | null {
    return this.quote ? new Date(this.quote.t * 1000).toISOString() : null;
  }

  ngOnInit(): void {
    this.quoteRequests.pipe(
      switchMap(symbol => this.marketQuotes.read(symbol)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(({ quote, previous }) => {
      this.quote = quote ? { ...quote, d: Number.isFinite(quote.d) ? quote.d : null,
        dp: Number.isFinite(quote.dp) ? quote.dp : null } : null;
      this.quoteLoading = false;
      this.quoteFailed = !quote;
      this.quotePrevious = previous;
    });

    this.historyRequests.pipe(
      switchMap(symbol => this.marketHistory.daily(symbol).pipe(
        map(({ results }) => results.filter(point => point.t > 0 && Number.isFinite(new Date(point.t).getTime()))),
        catchError(() => of(null)),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(history => {
      this.historyLoading = false;
      this.historyFailed = history === null || (!history.length && this.history.length > 0);
      if (this.historyFailed) return;
      this.history = history ?? [];
      this.setRange(this.activeRange);
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

    const browser = this.document.defaultView;
    if (browser && browser !== browser.top && typeof IntersectionObserver !== 'undefined') {
      this.embeddedVisible = false;
      const observer = new IntersectionObserver(entries => this.embeddedVisible = Boolean(entries[0]?.isIntersecting));
      observer.observe(this.host.nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    }
    activeRefreshes(this.document, quoteRefreshMs).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.embeddedVisible) this.retryQuote();
    });
    dailyRefreshes(this.document).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.retryHistory());
  }

  selectTicker(value: string): void {
    const symbol = value.trim().toUpperCase();
    if (!tickerPattern.test(symbol)) {
      this.inputError = 'Enter a U.S. stock symbol, such as AAPL or BRK.B.';
      return;
    }

    this.inputError = '';
    this.tickerInput = symbol;
    const linkedSymbol = this.route.snapshot.queryParamMap.get('ticker')?.trim().toUpperCase() || defaultTicker;
    if (symbol !== linkedSymbol) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: { ticker: symbol } });
    }
  }

  retryQuote(): void {
    if (this.quoteLoading || this.document.hidden || this.document.defaultView?.navigator.onLine === false) return;
    this.quoteLoading = true;
    this.quoteRequests.next(this.ticker);
  }

  retryHistory(): void {
    if (this.historyLoading || this.document.hidden || this.document.defaultView?.navigator.onLine === false) return;
    this.historyLoading = true;
    this.historyRequests.next(this.ticker);
  }

  setRange(range: ChartRange): void {
    this.activeRange = range;
    const latest = this.history.at(-1)?.t ?? 0;
    const start = latest - range.days * 86400000;
    const data = this.history.filter(point => point.t >= start).map(point => [point.t, point.c]);
    this.chartPoints = data.length;
    this.historyReturn = data.length > 1 ? (data[data.length - 1][1] / data[0][1] - 1) * 100 : null;
    this.chartOptions = {
      chart: { type: 'area', backgroundColor: 'transparent', spacing: [12, 6, 5, 6], animation: false },
      title: { text: undefined },
      credits: { enabled: false },
      exporting: { enabled: false },
      legend: { enabled: false },
      lang: { accessibility: { defaultChartTitle: this.ticker + ' daily closing prices' } },
      accessibility: {
        description: this.ticker + ' daily closing prices in U.S. dollars over ' + range.description + '.',
        point: { valueDecimals: 2, valuePrefix: '$' },
      },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 80,
        lineColor: '#d8e2f1',
        labels: { style: { color: '#50627e' } },
      },
      yAxis: {
        title: { text: undefined },
        opposite: true,
        gridLineColor: '#d8e2f1',
        labels: { style: { color: '#50627e' }, format: '${value}' },
      },
      tooltip: { valueDecimals: 2, valuePrefix: '$' },
      plotOptions: { series: { animation: false, marker: { enabled: false } } },
      series: [{
        type: 'area',
        name: this.ticker + ' close',
        color: '#2254dc',
        fillColor: {
          linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
          stops: [[0, '#dfebff'], [1, '#ffffff']],
        },
        threshold: null,
        data,
      }],
    };
  }

  private load(symbol: string): void {
    if (this.ticker !== symbol) {
      this.quote = null;
      this.history = [];
      this.historyReturn = null;
    }
    this.ticker = symbol;
    this.quoteFailed = false;
    this.quotePrevious = false;
    this.historyFailed = false;
    this.quoteLoading = true;
    this.historyLoading = true;
    this.quoteRequests.next(symbol);
    this.historyRequests.next(symbol);
  }
}
