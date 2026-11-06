import { CommonModule, DOCUMENT } from '@angular/common';
import { AfterViewInit, Component, DestroyRef, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { HighchartsChartModule } from 'highcharts-angular';
import type * as Highcharts from 'highcharts/highstock';
import { Subscription, timer } from 'rxjs';
import { MarketBar, MarketHistoryService, ResearchHistory } from '../../services/market-history.service';
import { activeRefreshes, retryAfterTime } from '../../services/market-refresh';
import { ResearchInterval, ResearchRange, bollinger, defaultInterval, ema, intervalReason, intraday, macd, points, researchIntervals, researchRanges, rsi, sessionVwap, sma } from './market-studies';

export interface ChartSelection { range: ResearchRange; interval: ResearchInterval; }
export interface ChartStudies { sma: boolean; ema: boolean; bb: boolean; vwap: boolean; volume: boolean; rsi: boolean; macd: boolean; period: number; }
export const defaultStudies = (): ChartStudies => ({ sma: true, ema: false, bb: false, vwap: false, volume: true, rsi: false, macd: false, period: 20 });

@Component({
  selector: 'app-market-research-chart', standalone: true,
  imports: [CommonModule, FormsModule, HighchartsChartModule],
  templateUrl: './market-research-chart.component.html',
  styleUrls: ['./market-research-chart.component.css'],
})
export class MarketResearchChartComponent implements OnChanges, AfterViewInit {
  @Input({ required: true }) symbol = '';
  @Input() currency = 'USD';
  @Input() selection: ChartSelection = { range: '1M', interval: '1d' };
  @Input() studies = defaultStudies();
  @Input() comparisonTicker: string | null = null;
  @Output() selectionChange = new EventEmitter<ChartSelection>();
  @Output() comparisonChange = new EventEmitter<string | null>();
  @Output() historyLoaded = new EventEmitter<ResearchHistory>();
  private readonly history = inject(MarketHistoryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private request?: Subscription;
  private comparisonRequest?: Subscription;
  private retryClock?: Subscription;
  private comparisonRetryClock?: Subscription;
  private requestedKey = '';
  private generation = 0;
  private retryAt = 0;
  private destroyed = false;
  readonly ranges = researchRanges;
  readonly intervals = researchIntervals;
  readonly intervalLabels: Record<ResearchInterval, string> = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '1h': '1 hour', '1d': '1 day', '1wk': '1 week', '1mo': '1 month' };
  runtime: typeof Highcharts | null = null;
  runtimeFailed = false;
  options: Highcharts.Options = {};
  result: ResearchHistory | null = null;
  visibleBars: MarketBar[] = [];
  loading = false;
  error = '';
  retrySeconds = 0;
  entitlementError = false;
  display: 'candlestick' | 'line' = 'candlestick';
  settingsOpen = false;
  comparisonInput = '';
  comparisonSymbol = '';
  comparisonInputError = '';
  comparisonError = '';
  comparisonLoading = false;
  comparisonRetrySeconds = 0;
  comparisonEntitlementError = false;
  comparison: ResearchHistory | null = null;
  studyNotes: string[] = [];
  private visible = true;

  constructor() {
    this.loadRuntime();
    activeRefreshes(this.document, 60_000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.visible && intraday(this.selection.interval) && !this.loading && !this.retrySeconds && !this.entitlementError) this.load(true);
    });
    this.destroyRef.onDestroy(() => { this.destroyed = true; this.generation++; this.request?.unsubscribe(); this.comparisonRequest?.unsubscribe(); this.retryClock?.unsubscribe(); this.comparisonRetryClock?.unsubscribe(); });
  }

  ngAfterViewInit(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    this.visible = false;
    let observed = false;
    const observer = new IntersectionObserver(entries => {
      const wasVisible = this.visible;
      this.visible = Boolean(entries[0]?.isIntersecting);
      if (observed && !wasVisible && this.visible && intraday(this.selection.interval)
        && !this.loading && !this.retrySeconds && !this.entitlementError
        && !this.document.hidden && this.document.defaultView?.navigator.onLine !== false) this.load(true);
      observed = true;
    });
    observer.observe(this.host.nativeElement);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  ngOnChanges(changes: SimpleChanges): void {
    const requestedComparison = this.comparisonTicker?.trim().toUpperCase() || '';
    const intendedComparison = changes['comparisonTicker'] ? requestedComparison : this.comparisonSymbol;
    if ((changes['symbol'] || changes['comparisonTicker']) && intendedComparison
      && intendedComparison === this.symbol.trim().toUpperCase()) this.removeComparison();
    const externalComparison = requestedComparison === this.symbol.trim().toUpperCase() ? '' : requestedComparison;
    const comparisonChanged = Boolean(changes['comparisonTicker']) && externalComparison !== this.comparisonSymbol;
    if (comparisonChanged) {
      this.comparisonRequest?.unsubscribe();
      this.comparisonSymbol = externalComparison;
      this.comparisonInput = externalComparison;
      this.comparison = null;
      this.comparisonInputError = '';
      this.clearComparisonFailure();
      this.render();
    }
    const key = `${this.symbol}:${this.selection.range}:${this.selection.interval}`;
    if (key !== this.requestedKey && this.symbol) this.load();
    else if (comparisonChanged) {
      if (externalComparison && this.result) this.loadComparison();
      else this.render();
    }
    else if (changes['currency'] || changes['studies']) this.render();
  }

  loadRuntime(): void {
    this.runtimeFailed = false;
    void import('../search-details/research-chart-runtime').then(({ Highcharts: runtime }) => {
      if (!this.destroyed) this.runtime = runtime;
    }, () => { if (!this.destroyed) this.runtimeFailed = true; });
  }

  reason(interval: ResearchInterval): string {
    const policy = intervalReason(this.selection.range, interval);
    if (policy) return policy;
    return this.result?.availableIntervals && !this.result.availableIntervals.includes(interval) ? 'This interval is unavailable for the selected range.' : '';
  }

  selectRange(range: ResearchRange): void {
    if (this.selection.range === range) return;
    const interval = intervalReason(range, this.selection.interval) || ['1D', '5D'].includes(range) && !intraday(this.selection.interval)
      ? defaultInterval(range) : this.selection.interval;
    this.changeSelection({ range, interval });
  }

  selectInterval(value: string): void {
    const interval = value as ResearchInterval;
    if (this.reason(interval) || interval === this.selection.interval) return;
    this.changeSelection({ ...this.selection, interval });
  }

  private changeSelection(selection: ChartSelection): void {
    this.selection = selection;
    this.selectionChange.emit(selection);
    this.load();
  }

  load(refresh = false, allowAutomaticRetry = true): void {
    if (!this.symbol || this.retrySeconds && refresh) return;
    const key = `${this.symbol}:${this.selection.range}:${this.selection.interval}`;
    const changed = key !== this.requestedKey;
    const generation = ++this.generation;
    this.request?.unsubscribe();
    this.comparisonRequest?.unsubscribe();
    this.comparisonLoading = false;
    if (changed) this.clearComparisonFailure();
    this.requestedKey = key;
    this.loading = true;
    this.error = '';
    this.entitlementError = false;
    if (changed) { this.result = null; this.visibleBars = []; this.options = {}; this.comparison = null; }
    this.request = this.history.history(this.symbol, this.selection.range, this.selection.interval, refresh).subscribe({
      next: result => {
        if (generation !== this.generation) return;
        this.loading = false;
        if (!result.results.length && this.result?.results.length) {
          this.error = 'The refresh returned no prices. Showing the last available data for this selection.';
          return;
        }
        this.result = result;
        this.retryAt = 0;
        this.retrySeconds = 0;
        this.retryClock?.unsubscribe();
        this.render();
        this.historyLoaded.emit(result);
        if (this.comparisonSymbol) this.loadComparison(refresh);
      },
      error: (error: HttpErrorResponse) => {
        if (generation !== this.generation) return;
        this.loading = false;
        this.entitlementError = error.status === 403;
        const explicit = retryAfterTime(error.headers?.get('Retry-After') ?? null, Date.now());
        this.retryAt = explicit ?? (error.status === 429 ? Date.now() + 30_000 : 0);
        this.retrySeconds = Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000));
        this.retryClock?.unsubscribe();
        if (this.retrySeconds) this.retryClock = timer(1000, 1000).subscribe(() => {
          this.retrySeconds = Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000));
          if (!this.retrySeconds) {
            this.retryClock?.unsubscribe();
            if (allowAutomaticRetry && !this.result && generation === this.generation && this.error && this.canRetryOnScreen) this.load(true, false);
          }
        });
        this.error = error.status === 403
          ? `The connected data plan does not provide this history. Choose a shorter range${this.isIntraday ? ' or a daily interval' : ''}.`
          : error.status === 400 ? 'This range and interval are not supported. Choose another interval.'
          : error.status === 404 ? `No price history is available for ${this.symbol}.`
          : this.retrySeconds && !this.result && allowAutomaticRetry
            ? 'The data provider is busy. This chart will retry once when the countdown ends if it is visible.'
            : `Prices are temporarily unavailable.${this.result ? ' Showing the last available data for this selection.' : ' Try again when the data service is available.'}`;
      },
    });
  }

  get periodReturn(): number | null {
    return this.visibleBars.length > 1 ? (this.visibleBars.at(-1)!.c / this.visibleBars[0].c - 1) * 100 : null;
  }
  get isIntraday(): boolean { return intraday(this.selection.interval); }
  get hasVolume(): boolean { return this.visibleBars.some(bar => typeof bar.v === 'number' && Number.isFinite(bar.v) && bar.v > 0); }
  get canVwap(): boolean { return this.isIntraday && this.hasVolume && this.visibleBars.some(bar => typeof bar.vw === 'number' && Number.isFinite(bar.vw) && bar.vw > 0); }
  get hasCandles(): boolean { return this.visibleBars.length > 0 && this.visibleBars.every(bar => [bar.o, bar.h, bar.l].every(Number.isFinite) && bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c)); }
  get rangeSummary(): string { return this.result?.availability?.message || `No ${this.intervalLabels[this.selection.interval]} bars were returned for this range.`; }

  formatTime(time: number): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric',
      ...(this.isIntraday ? { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' } as const : { year: 'numeric' } as const) }).format(time);
  }

  updateStudies(): void {
    this.studies.period = Math.min(200, Math.max(2, Math.floor(Number(this.studies.period) || 20)));
    this.render();
  }

  compare(): void {
    const symbol = this.comparisonInput.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(symbol) || symbol === this.symbol.toUpperCase()) {
      this.clearComparisonFailure();
      this.comparisonInputError = 'Enter a different stock or ETF symbol.';
      return;
    }
    this.comparisonInputError = '';
    this.clearComparisonFailure();
    this.comparisonSymbol = symbol;
    this.comparisonInput = symbol;
    this.comparison = null;
    this.render();
    this.comparisonChange.emit(symbol);
    this.loadComparison();
  }

  removeComparison(): void {
    this.comparisonRequest?.unsubscribe();
    this.comparison = null;
    this.comparisonSymbol = '';
    this.comparisonInput = '';
    this.comparisonInputError = '';
    this.clearComparisonFailure();
    this.comparisonLoading = false;
    this.comparisonChange.emit(null);
    this.render();
  }

  private get canRetryOnScreen(): boolean {
    return this.visible && !this.document.hidden && this.document.defaultView?.navigator.onLine !== false;
  }

  loadComparison(refresh = false, allowAutomaticRetry = true): void {
    if (!this.result || !/^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(this.comparisonSymbol)
      || this.comparisonSymbol === this.symbol.toUpperCase()
      || refresh && (this.comparisonWaitSeconds > 0 || this.comparisonEntitlementError)) return;
    this.comparisonRequest?.unsubscribe();
    const generation = this.generation;
    this.comparisonLoading = true;
    this.clearComparisonFailure();
    this.comparisonRequest = this.history.history(this.comparisonSymbol, this.selection.range, this.selection.interval, refresh).subscribe({
      next: value => {
        if (generation !== this.generation) return;
        this.comparisonLoading = false;
        this.comparison = value;
        this.render();
      },
      error: (error: HttpErrorResponse) => {
        if (generation !== this.generation) return;
        this.comparisonLoading = false;
        this.comparisonEntitlementError = error.status === 403;
        const explicit = retryAfterTime(error.headers?.get('Retry-After') ?? null, Date.now());
        const retryAt = explicit ?? (error.status === 429 ? Date.now() + 30_000 : 0);
        this.comparisonRetrySeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
        if (this.comparisonRetrySeconds) this.comparisonRetryClock = timer(1000, 1000).subscribe(() => {
          this.comparisonRetrySeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
          if (!this.comparisonRetrySeconds) {
            this.comparisonRetryClock?.unsubscribe();
            if (allowAutomaticRetry && !this.comparison && generation === this.generation && this.comparisonError && this.canRetryOnScreen) this.loadComparison(true, false);
          }
        });
        this.comparisonError = this.comparisonEntitlementError
          ? `The connected data plan does not provide this comparison history for ${this.comparisonSymbol}. Choose a shorter range${this.isIntraday ? ' or a daily interval' : ''}, or another symbol.`
          : this.comparisonRetrySeconds && !this.comparison && allowAutomaticRetry
            ? `The data provider is busy. The ${this.comparisonSymbol} comparison will retry once when the countdown ends if it is visible.`
            : `Comparison prices for ${this.comparisonSymbol} are unavailable.${this.comparison ? ' Showing the last available comparison.' : ''} Try another symbol or retry${this.comparisonRetrySeconds ? ' after the countdown' : ''}.`;
      },
    });
  }

  get comparisonWaitSeconds(): number { return Math.max(this.retrySeconds, this.comparisonRetrySeconds); }

  private clearComparisonFailure(): void {
    this.comparisonError = '';
    this.comparisonEntitlementError = false;
    this.comparisonRetrySeconds = 0;
    this.comparisonRetryClock?.unsubscribe();
  }

  render(): void {
    const result = this.result;
    if (!result) return;
    const bars = result.results;
    const visibleFrom = result.visibleFrom || bars[0]?.t || 0;
    this.visibleBars = bars.filter(bar => bar.t >= visibleFrom && (!result.visibleTo || bar.t <= result.visibleTo));
    if (!this.visibleBars.length) return;
    const values = bars.map(bar => bar.c);
    const series: Highcharts.SeriesOptionsType[] = [];
    const axes: Highcharts.YAxisOptions[] = [];
    const panes: { id: string; name: string; weight: number; options?: Highcharts.YAxisOptions }[] = [{ id: 'price-axis', name: this.currency || 'Price', weight: 3.5 }];
    this.studyNotes = [];
    const study = (name: string, values: Array<number | null>, color: string, axis = 'price-axis', dashStyle?: Highcharts.DashStyleValue,
      options: Partial<Highcharts.SeriesLineOptions> = {}) => {
      const data = points(bars, values, visibleFrom);
      if (!data.some(point => point[1] !== null)) { this.studyNotes.push(`${name}: not enough prior bars for calculation.`); return; }
      series.push({ type: 'line', name, data, color, yAxis: axis, lineWidth: 1.4, dashStyle, marker: { enabled: false }, showInNavigator: false, ...options });
    };
    if (this.display === 'candlestick' && this.hasCandles) {
      series.push({ type: 'candlestick', id: 'price', yAxis: 'price-axis', name: this.symbol, data: this.visibleBars.map(bar => [bar.t, bar.o, bar.h, bar.l, bar.c]), color: '#b65555', upColor: '#268375', lineColor: '#b65555', upLineColor: '#268375' });
    } else {
      series.push({ type: 'line', id: 'price', yAxis: 'price-axis', name: `${this.symbol} close`, data: this.visibleBars.map(bar => [bar.t, bar.c]), color: '#345d9c', lineWidth: 1.8 });
      if (this.display === 'candlestick') this.studyNotes.push('OHLC data is incomplete; closing prices are shown instead.');
    }
    if (this.studies.sma) study(`SMA ${this.studies.period}`, sma(values, this.studies.period), '#a0793f', 'price-axis', undefined, { id: 'sma' });
    if (this.studies.ema) study(`EMA ${this.studies.period}`, ema(values, this.studies.period), '#6577a2', 'price-axis', undefined, { id: 'ema' });
    if (this.studies.bb) {
      const bb = bollinger(values);
      study('Bollinger upper · 20, 2σ', bb.upper, '#8b7b9e', 'price-axis', 'ShortDot', { id: 'bollinger' });
      study('Bollinger middle · 20', bb.middle, '#8b7b9e', 'price-axis', 'ShortDash', { id: 'bollinger-middle', linkedTo: 'bollinger', showInLegend: true });
      study('Bollinger lower · 20, 2σ', bb.lower, '#8b7b9e', 'price-axis', 'ShortDot', { id: 'bollinger-lower', linkedTo: 'bollinger', showInLegend: true });
    }
    if (this.studies.vwap) {
      if (this.canVwap) study('Session VWAP', sessionVwap(bars), '#3c9295', 'price-axis', undefined, { id: 'vwap' });
      else this.studyNotes.push('Session VWAP requires intraday bars with provider volume and VWAP.');
    }
    if (this.studies.volume && this.hasVolume) {
      panes.push({ id: 'volume-axis', name: 'Volume', weight: .85 });
      series.push({ type: 'column', id: 'volume', name: 'Volume', yAxis: 'volume-axis', data: this.visibleBars.map(bar => ({ x: bar.t, y: typeof bar.v === 'number' && Number.isFinite(bar.v) && bar.v >= 0 ? bar.v : null, color: bar.c >= bar.o ? '#94b8ae' : '#d3a8a4' })), showInNavigator: false, tooltip: { valueDecimals: 0 } });
    } else if (this.studies.volume) this.studyNotes.push('Volume data is unavailable.');
    if (this.studies.rsi) {
      panes.push({ id: 'rsi-axis', name: 'RSI 14', weight: 1, options: { min: 0, max: 100, startOnTick: false, endOnTick: false, tickPositions: [0, 30, 70, 100], plotLines: [30, 70].map(value => ({ value, color: '#bfc8d4', width: 1, dashStyle: 'ShortDash' })) } });
      study('RSI 14', rsi(values), '#796297', 'rsi-axis', undefined, { id: 'rsi' });
    }
    if (this.studies.macd) {
      panes.push({ id: 'macd-axis', name: 'MACD', weight: 1.1 });
      const calculated = macd(values);
      study('MACD 12, 26', calculated.line, '#345d9c', 'macd-axis', undefined, { id: 'macd' });
      study('Signal 9', calculated.signal, '#a0793f', 'macd-axis', undefined, { id: 'macd-signal', linkedTo: 'macd', showInLegend: true });
      series.push({ type: 'column', id: 'macd-histogram', name: 'MACD histogram', linkedTo: 'macd', showInLegend: true, data: points(bars, calculated.histogram, visibleFrom), yAxis: 'macd-axis', color: '#9fb5cf', negativeColor: '#d4b4af', showInNavigator: false });
    }
    if (this.comparison) {
      const other = new Map(this.comparison.results.map(bar => [bar.t, bar.c]));
      const aligned = this.visibleBars.filter(bar => other.has(bar.t));
      if (aligned.length > 1) {
        panes.push({ id: 'return-axis', name: 'Return %', weight: 1.3, options: { labels: { format: '{value}%' } } });
        const first = aligned[0];
        for (const comparison of [{ id: 'primary-return', name: this.symbol, color: '#345d9c', base: first.c, value: (bar: MarketBar) => bar.c },
          { id: 'comparison-return', name: this.comparisonSymbol, color: '#a0793f', base: other.get(first.t)!, value: (bar: MarketBar) => other.get(bar.t)! }]) {
          series.push({ type: 'line', id: comparison.id, name: `${comparison.name} return`, color: comparison.color, yAxis: 'return-axis', data: aligned.map(bar => [bar.t, (comparison.value(bar) / comparison.base - 1) * 100]), showInNavigator: false, tooltip: { valueSuffix: '%' } });
        }
      } else this.comparisonError = 'There are too few matching timestamps to compare these securities in this range.';
    }
    const total = panes.reduce((sum, pane) => sum + pane.weight, 0);
    let top = 0;
    panes.forEach(pane => {
      const height = pane.weight / total * 100;
      axes.push({ id: pane.id, title: { text: pane.name, align: 'high', rotation: 0, offset: 0, x: -4, y: -8, style: { fontSize: '10px', color: '#64748b' } },
        top: `${top}%`, height: `${height - 3}%`, offset: 0, opposite: true, gridLineColor: '#edf0f4', gridLineWidth: 1, lineWidth: 0,
        labels: { style: { color: '#68758a', fontSize: '10px' }, x: 4 }, ...pane.options });
      top += height;
    });
    this.options = {
      chart: { backgroundColor: 'transparent', animation: false, height: Math.max(370, 270 + (panes.length - 1) * 115), spacing: [24, 5, 4, 5], style: { fontFamily: 'inherit' }, zooming: { type: 'x' } },
      title: { text: undefined }, credits: { enabled: false }, exporting: { enabled: false },
      rangeSelector: { enabled: false }, navigator: { enabled: true, height: 32, margin: 18, maskFill: 'rgba(52,93,156,0.07)' }, scrollbar: { enabled: false },
      legend: { enabled: true, align: 'left', verticalAlign: 'top', itemStyle: { fontSize: '10px', fontWeight: 'normal', color: '#536279' }, itemHiddenStyle: { color: '#a4acb6' } },
      xAxis: { type: 'datetime', ordinal: true, min: this.visibleBars[0].t, max: this.visibleBars.at(-1)!.t, crosshair: true, lineColor: '#dce3eb', labels: { style: { color: '#68758a' } } },
      yAxis: axes, time: { timezone: 'America/New_York' },
      tooltip: { split: true, valueDecimals: 2, xDateFormat: this.isIntraday ? '%b %e, %Y · %H:%M ET' : '%b %e, %Y', outside: false },
      accessibility: { description: `${this.symbol} ${this.intervalLabels[this.selection.interval]} prices with selected technical studies over ${this.selection.range}.` },
      responsive: { rules: [{ condition: { maxWidth: 600 }, chartOptions: {
        chart: { height: Math.max(390, 285 + (panes.length - 1) * 115), spacingTop: 14 },
        legend: {
          layout: 'horizontal', alignColumns: true, itemWidth: 135, itemDistance: 6,
          itemMarginBottom: 3, padding: 0, symbolWidth: 13, symbolPadding: 5,
          labelFormatter: function () {
            const name = this.name || '';
            return name.startsWith('Bollinger upper') ? 'Bollinger · 20, 2σ'
              : name.startsWith('MACD 12') ? 'MACD · 12, 26, 9' : name;
          },
        },
        // Linked lines keep their full tooltip names; a single legend item toggles the whole study.
        series: series.map(item => ({ id: item.id, showInLegend: !('linkedTo' in item) || !['bollinger', 'macd'].includes(item.linkedTo || '') })) as Highcharts.SeriesOptionsType[],
        yAxis: panes.map((pane, index) => pane.name === 'RSI 14'
          ? { id: pane.id, min: 0, max: 100, startOnTick: false, endOnTick: false, tickPositions: [30, 70] }
          : { id: pane.id, tickAmount: index === 0 ? 4 : 3 }),
      } }] },
      plotOptions: { series: { animation: false, dataGrouping: { enabled: false }, marker: { enabled: false }, turboThreshold: 0 }, column: { borderWidth: 0, groupPadding: .05, pointPadding: .05 } },
      series,
    };
  }
}
