import { Component, DestroyRef, inject, OnDestroy, OnInit, TemplateRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {Observable, of, Subscription, interval, forkJoin} from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, filter, finalize, map, startWith, switchMap, takeUntil, tap } from 'rxjs/operators';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import {FormControl} from "@angular/forms";
import * as Highcharts from 'highcharts/highstock';
import HC_accessibility from 'highcharts/modules/accessibility';
HC_accessibility(Highcharts);
import volumeByPrice from 'highcharts/indicators/volume-by-price';
import indicators from 'highcharts/indicators/indicators';
indicators(Highcharts);
volumeByPrice(Highcharts);
import { paperOrderConfirmation, PendingOrderError, PendingPaperOrder, PortfolioService } from '../../services/portfolio.service';
import { MarketBar as AggregateBarResponse, MarketHistoryService, utcDayMonthsBefore, validClosingBars } from '../../services/market-history.service';

export interface QuoteResponse {
  c: number;
  d: number;
  dp: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

export interface StockResult {
  displaySymbol: string;
  description: string;
  symbol: string;
  type: string;
}
export interface CompanyProfile {
  country: string;
  currency: string;
  exchange: string;
  name: string;
  ticker: string;
  ipo: string;
  marketCapitalization: number;
  shareOutstanding: number;
  logo: string;
  phone: string;
  weburl: string;
  finnhubIndustry: string;
}

export interface TopNews {
  image: string;
  imageReady: boolean;
  headline: string;
  source: string;
  datetime: number;
  summary: string;
  url: string;
}
export interface Trend {
  buy: number;
  hold: number;
  period: string;
  sell: number;
  strongBuy: number;
  strongSell: number;
  Symbol: string;
}

export interface InsiderInsightData {
  symbol: string;
  year: number;
  month: number;
  change: number;
  mspr: number;
}

export interface InsiderInsightsResponse {
  data: InsiderInsightData[];
  symbol: string;
}

export interface InsiderSummary {
  totalMspr: number;
  positiveMspr: number;
  negativeMspr: number;
  totalChange: number;
  positiveChange: number;
  negativeChange: number;
}

export interface Earning {
  actual: number | null;
  estimate: number | null;
  period: string;
  symbol: string;
  surprise: number | null;
}

type DetailTab = 'summary' | 'news' | 'charts' | 'insights';
const historyRanges = ['1M', '3M', '6M', 'YTD', '1Y', 'All'] as const;
type HistoryRange = typeof historyRanges[number];
const overviewRanges = ['Hourly', '1M', '3M', '1Y'] as const;
type OverviewRange = typeof overviewRanges[number];


@Component({
  selector: 'app-search-details',
  templateUrl: './search-details.component.html',
  styleUrls: ['./search-details.component.css'],
})
export class SearchDetailsComponent implements OnInit, OnDestroy {
  tickerFormControl = new FormControl<string | StockResult>('', { nonNullable: true });
  filteredOptions: Observable<StockResult[]> = of([]);
  isLoading = false;
  DetailIsLoading = false;
  quoteLoading = false;
  searchError = '';
  suggestionsError = false;
  watchlistPending = false;
  watchlistLoading = false;
  watchlistUnavailable = false;
  hourlyLoading = false;
  hourlyFailed = false;
  readonly overviewRanges = overviewRanges;
  overviewRange: OverviewRange = '1M';
  overviewStart: number | null = null;
  overviewEnd: number | null = null;
  overviewReturn: number | null = null;
  private hourlyBars: AggregateBarResponse[] | null = null;
  private overviewDailyBars: AggregateBarResponse[] | null = null;
  private overviewDailyLoading = false;
  private overviewDailyFailed = false;
  private requestedTicker: string | null = null;
  readonly loadingTabs = new Set<DetailTab>();
  readonly failedTabs = new Set<DetailTab>();
  private readonly loadedTabs = new Set<DetailTab>();
  readonly detailTabs: ReadonlyArray<{ id: DetailTab; label: string }> = [
    { id: 'summary', label: 'Overview' },
    { id: 'news', label: 'Top News' },
    { id: 'charts', label: 'Charts' },
    { id: 'insights', label: 'Insights' },
  ];
  private readonly destroyRef = inject(DestroyRef);
  private searchSubscription = new Subscription();
  activeTab: DetailTab = 'summary';
  searchResults: CompanyProfile | null = null;


  private lastSuccessfulSearch: string | null = null;
  private confirmationTimeout?: ReturnType<typeof setTimeout>;

  currentStock: QuoteResponse | null = null;
  companyPeers: string[] = [];

  Highcharts: typeof Highcharts = Highcharts;
  chartOptions: Highcharts.Options = {};
  trendChartOptions: Highcharts.Options = {};
  earningChartOptions: Highcharts.Options = {};



  isFavorited: boolean = false;


  topNews: TopNews[] = [];
  visibleNewsCount = 12;
  selectedNewsItem: TopNews | null = null;

  bigChartOptions: Highcharts.Options = {};
  readonly historyRanges = historyRanges;
  historyRange: HistoryRange | null = '1M';
  historyEnd: number | null = null;
  private historyStart: number | null = null;

  earnings: Earning[] = [];
  sentiments: InsiderInsightsResponse | null = null;
  calculatedSentiments: InsiderSummary = {
    totalMspr: 0,
    positiveMspr: 0,
    negativeMspr: 0,
    totalChange: 0,
    positiveChange: 0,
    negativeChange: 0
  };
  recommendations: Trend[] = [];


  showConfirmation: boolean = false;
  confirmationMessage: string = '';
  confirmationStyle: string = '';


  tradeSide: 'buy' | 'sell' = 'buy';
  tradeQuantity: number | null = 1;
  tradeError = '';
  tradePending = false;
  tradeNeedsRefresh = false;
  walletLoading = false;
  walletInitialized: boolean | undefined;
  userWalletBalance = 0;
  ownedStockQuantity = 0;
  private tradeModal?: NgbModalRef;
  private pendingTrade?: PendingPaperOrder;
  private newsModal?: NgbModalRef;

  get showSearchHero(): boolean {
    return !this.searchResults && !this.DetailIsLoading;
  }

  get overviewLoading(): boolean {
    return this.overviewRange === 'Hourly' ? this.hourlyLoading || this.quoteLoading : this.overviewDailyLoading;
  }

  get overviewFailed(): boolean {
    return this.overviewRange === 'Hourly' ? this.hourlyFailed : this.overviewDailyFailed;
  }

  get hourlyLagsQuote(): boolean {
    return this.overviewRange === 'Hourly' && this.overviewEnd !== null && !!this.currentStock
      && this.currentStock.t * 1000 - this.overviewEnd > 4 * 60 * 60 * 1000;
  }

  constructor(
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private portfolioService: PortfolioService,
    private marketHistory: MarketHistoryService,
    private modal: NgbModal
  ) {}

  ngOnInit(): void {
    this.setupSearch();
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      startWith(null),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.syncResearchView());
    this.setupAutoUpdate();
  }

  private showConfirmationMessage(message: string, isError = false): void {
    clearTimeout(this.confirmationTimeout);
    this.confirmationMessage = message;
    this.confirmationStyle = isError ? 'alert-danger' : 'alert-success';
    this.showConfirmation = true;
    this.confirmationTimeout = setTimeout(() => this.closeConfirmation(), 5000);
  }

  private refreshHolding(ticker: string): void {
    this.searchSubscription.add(this.portfolioService.checkStock(ticker).subscribe({
      next: position => {
        if (ticker === this.lastSuccessfulSearch) this.ownedStockQuantity = position.quantity;
      },
      error: () => {
        if (ticker === this.lastSuccessfulSearch) this.ownedStockQuantity = 0;
      }
    }));
  }

  get supportsPaperTrade(): boolean {
    return this.searchResults?.currency === 'USD';
  }

  openTrade(template: TemplateRef<unknown>, side: 'buy' | 'sell'): void {
    if (!this.currentStock || !this.supportsPaperTrade || this.tradeModal || this.tradePending) return;
    const ticker = this.lastSuccessfulSearch;
    const pending = ticker ? this.portfolioService.getPendingOrder(side, ticker) : undefined;
    this.pendingTrade = pending;
    this.tradeSide = side;
    this.tradeQuantity = pending?.quantity ?? 1;
    this.tradeError = pending ? 'This order is awaiting confirmation. Retry with the original order ID.' : '';
    this.tradeNeedsRefresh = Boolean(pending);
    this.userWalletBalance = 0;
    this.walletInitialized = undefined;
    this.walletLoading = side === 'buy' && !pending;
    const tradeModal = this.modal.open(template, {
      ariaLabelledBy: 'trade-dialog-title',
      centered: true,
      beforeDismiss: () => !this.tradePending
    });
    this.tradeModal = tradeModal;
    const clearTrade = () => {
      if (this.tradeModal === tradeModal) this.tradeModal = undefined;
    };
    tradeModal.result.then(clearTrade, clearTrade);

    if (this.walletLoading) {
      this.portfolioService.getBalance().pipe(
        takeUntilDestroyed(this.destroyRef),
        takeUntil(tradeModal.hidden),
        finalize(() => { if (this.tradeModal === tradeModal) this.walletLoading = false; })
      ).subscribe({
        next: ({ balance, initialized }) => {
          if (this.tradeModal !== tradeModal) return;
          this.userWalletBalance = balance;
          this.walletInitialized = initialized;
        },
        error: () => {
          if (this.tradeModal === tradeModal) this.tradeError = 'Could not load your balance. Close this dialog and try again.';
        }
      });
    }
  }

  get estimatedTradeTotal(): number {
    return (this.tradeQuantity ?? 0) * (this.currentStock?.c ?? 0);
  }

  get canSubmitTrade(): boolean {
    const quantity = this.tradeQuantity ?? 0;
    const price = this.currentStock?.c ?? 0;
    if (this.tradePending || !Number.isSafeInteger(quantity) || quantity < 1) return false;
    if (this.tradeNeedsRefresh) return true;
    return this.supportsPaperTrade && !this.walletLoading && price > 0 && (this.tradeSide === 'buy'
        ? this.walletInitialized !== false && this.estimatedTradeTotal <= this.userWalletBalance
        : quantity <= this.ownedStockQuantity);
  }

  submitTrade(): void {
    const ticker = this.lastSuccessfulSearch;
    const quantity = this.tradeQuantity;
    if (!this.canSubmitTrade || !ticker || !quantity) return;

    const side = this.tradeSide;
    const context = this.searchSubscription;
    this.tradePending = true;
    this.tradeError = '';
    const trade = this.pendingTrade
      ? this.portfolioService.retryOrder(this.pendingTrade)
      : this.portfolioService.placeOrder(side, ticker, quantity);
    trade.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.tradePending = false)
    ).subscribe({
      next: receipt => {
        if (this.lastSuccessfulSearch === ticker) this.refreshHolding(ticker);
        if (this.searchSubscription !== context) return;
        this.tradeModal?.close();
        this.showConfirmationMessage(paperOrderConfirmation(receipt));
      },
      error: (error: HttpErrorResponse | PendingOrderError) => {
        if (this.searchSubscription !== context) return;
        this.pendingTrade = error instanceof PendingOrderError ? error.order : undefined;
        this.tradeNeedsRefresh = Boolean(this.pendingTrade);
        if (this.tradeNeedsRefresh) {
          this.refreshHolding(ticker);
          this.tradeError = 'This order is awaiting confirmation. Retry the same order here or from Portfolio.';
        } else {
          this.tradeError = error instanceof HttpErrorResponse && typeof error.error?.message === 'string'
            ? error.error.message
            : 'The order did not go through. Please try again.';
        }
      }
    });
  }

  createInsightChart(): void {
    const earnings = [...this.earnings].sort((a, b) => a.period.localeCompare(b.period)).slice(-6);
    const trends = [...this.recommendations].sort((a, b) => a.period.localeCompare(b.period)).slice(-6);
    const ticker = this.lastSuccessfulSearch ?? '';
    const shared: Highcharts.Options = {
      chart: { backgroundColor: 'transparent', animation: false, style: { fontFamily: 'inherit' } },
      title: { text: '' },
      legend: { enabled: true, itemStyle: { fontSize: '11px', color: '#50627e' } },
      plotOptions: { series: { animation: false } },
      tooltip: { shared: true },
      exporting: { enabled: false },
    };
    const monthLabel = (value: string) => {
      const date = new Date(value + 'T00:00:00Z');
      return Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(date)
        : value;
    };
    const quarterLabel = (value: string) => {
      const month = Number(value.slice(5, 7));
      return `Q${Math.ceil(month / 3)} ’${value.slice(2, 4)}`;
    };

    this.earningChartOptions = {
      ...shared,
      accessibility: { landmarkVerbosity: 'one', description: `Quarterly reported and estimated earnings per share for ${ticker}.` },
      lang: { accessibility: { chartContainerLabel: 'Quarterly earnings chart' } },
      xAxis: { categories: earnings.map(earning => quarterLabel(earning.period)), labels: { autoRotation: [] } },
      yAxis: { title: { text: '' }, gridLineColor: '#e3eaf7' },
      tooltip: { shared: true, valueDecimals: 2 },
      series: [
        {
          type: 'line', name: 'Actual EPS', color: '#245adb',
          data: earnings.map(earning => ({
            y: earning.actual,
            custom: { surprise: earning.surprise?.toFixed(2) ?? '—' },
          })),
          tooltip: { pointFormat: '{series.name}: <b>{point.y}</b> · Surprise: {point.custom.surprise}<br/>' },
        },
        { type: 'line', name: 'Estimated EPS', color: '#62769b', dashStyle: 'ShortDash', data: earnings.map(earning => earning.estimate) },
      ],
    };

    const ratings = [
      { name: 'Strong buy', color: '#245adb', values: trends.map(trend => trend.strongBuy) },
      { name: 'Buy', color: '#7198e9', values: trends.map(trend => trend.buy) },
      { name: 'Hold', color: '#be8a40', values: trends.map(trend => trend.hold) },
      { name: 'Sell', color: '#ba6368', values: trends.map(trend => trend.sell) },
      { name: 'Strong sell', color: '#893d4b', values: trends.map(trend => trend.strongSell) },
    ];
    this.trendChartOptions = {
      ...shared,
      accessibility: { landmarkVerbosity: 'one', description: `Monthly distribution of analyst ratings for ${ticker}.` },
      lang: { accessibility: { chartContainerLabel: 'Analyst recommendations chart' } },
      xAxis: { categories: trends.map(trend => monthLabel(trend.period)), labels: { autoRotation: [] } },
      yAxis: { min: 0, allowDecimals: false, title: { text: '' }, gridLineColor: '#e3eaf7' },
      plotOptions: { ...shared.plotOptions, column: { stacking: 'normal', borderWidth: 0 } },
      series: ratings.map(rating => ({ type: 'column', name: rating.name, color: rating.color, data: rating.values })),
    };
  }

  getTopNews(ticker: string): Observable<TopNews[]> {
    return this.http.get<unknown>('/company_news', { params: { symbol: ticker } }).pipe(
      map(payload => {
        if (!Array.isArray(payload)) throw new Error('Unexpected news response');

        const seenUrls = new Set<string>();
        const seenHeadlines = new Set<string>();
        const imageCounts = new Map<string, number>();
        const articles: TopNews[] = [];
        for (const item of payload) {
          const headline = this.newsText(item?.headline);
          const url = this.httpsUrl(item?.url);
          const key = headline.toLowerCase();
          if (!headline || !url || seenUrls.has(url) || seenHeadlines.has(key)) continue;
          seenUrls.add(url);
          seenHeadlines.add(key);

          const image = this.httpsUrl(item.image);
          if (image) imageCounts.set(image, (imageCounts.get(image) ?? 0) + 1);
          articles.push({
            headline, url, image, imageReady: false,
            source: this.newsText(item.source) || new URL(url).hostname,
            summary: this.newsText(item.summary),
            datetime: Number.isFinite(item.datetime) && item.datetime > 0 && item.datetime < 4_102_444_800
              ? item.datetime : 0,
          });
        }

        return articles.sort((a, b) => b.datetime - a.datetime).slice(0, 40).map(article => {
          if ((imageCounts.get(article.image) ?? 0) > 2) article.image = '';
          return article;
        });
      })
    );
  }

  private newsText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private httpsUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  }

  validateNewsImage(event: Event, article: TopNews): void {
    const image = event.target as HTMLImageElement;
    const ratio = image.naturalWidth / image.naturalHeight;
    if (image.naturalWidth < 160 || image.naturalHeight < 90 || ratio > 3.5 || ratio < .65) {
      this.discardNewsImage(article);
    } else {
      article.imageReady = true;
    }
  }

  discardNewsImage(article: TopNews): void {
    article.image = '';
    article.imageReady = false;
  }

  showMoreNews(): void {
    const firstNewItem = this.visibleNewsCount + 1;
    this.visibleNewsCount += 12;
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`.news-list li:nth-child(${firstNewItem}) .news-row`)?.focus();
    });
  }
  openNews(template: TemplateRef<unknown>, newsItem: TopNews): void {
    if (this.newsModal) return;
    this.selectedNewsItem = newsItem;
    this.newsModal = this.modal.open(template, {
      ariaLabelledBy: 'news-dialog-title',
      centered: true,
      scrollable: true
    });
    const clearArticle = () => {
      this.newsModal = undefined;
      this.selectedNewsItem = null;
    };
    this.newsModal.result.then(clearArticle, clearArticle);
  }

  shareOnPlatform(newsItem: TopNews, platform: string): void {
    let url: string = '';
    if (platform === 'twitter') {
      url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(newsItem.headline)}&url=${encodeURIComponent(newsItem.url)}`;
    } else if (platform === 'facebook') {
      url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(newsItem.url)}`;
    }
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  getEarnings(ticker: string): Observable<Earning[]> {
    return this.http.get<Earning[]>('/company_Earning', { params: { symbol: ticker } }).pipe(
      map(rows => rows.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row?.period)).map(row => ({
        ...row,
        actual: Number.isFinite(row.actual) ? row.actual : null,
        estimate: Number.isFinite(row.estimate) ? row.estimate : null,
        surprise: Number.isFinite(row.surprise) ? row.surprise : null,
      }))),
    );
  }

  getSentiments(ticker: string): Observable<InsiderInsightsResponse> {
    const url = `/company_sentiment?symbol=${ticker}`;
    return this.http.get<InsiderInsightsResponse>(url);
  }
  calculateSummary(): void {
    if (this.sentiments) {
      const initialValue: InsiderSummary = {
        totalMspr: 0,
        positiveMspr: 0,
        negativeMspr: 0,
        totalChange: 0,
        positiveChange: 0,
        negativeChange: 0
      };

      this.calculatedSentiments = (this.sentiments.data ?? []).reduce((accumulator, current) => {
        accumulator.totalMspr += current.mspr;
        accumulator.totalChange += current.change;

        if (current.mspr > 0) {
          accumulator.positiveMspr += current.mspr;
        } else if (current.mspr < 0) {
          accumulator.negativeMspr += current.mspr;
        }

        if (current.change > 0) {
          accumulator.positiveChange += current.change;
        } else if (current.change < 0) {
          accumulator.negativeChange += current.change;
        }
        return accumulator;
      }, initialValue);
    }
  }
  getRecommendations(ticker: string): Observable<Trend[]> {
    const url = `/company_recommendation?symbol=${ticker}`;
    return this.http.get<Trend[]>(url);
  }
  getBigChartData(ticker: string): Observable<{ results: AggregateBarResponse[] }> {
    return this.marketHistory.daily(ticker);
  }
  createBigChart(data: { results: AggregateBarResponse[] }, ticker: string): Highcharts.Options {
    const bars = data.results.filter(bar => bar && [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite))
      .sort((a, b) => a.t - b.t);
    if (!bars.length) return {};
    this.historyStart = bars[0].t;
    this.historyEnd = bars[bars.length - 1].t;
    const ohlc = bars.map(bar => [
      bar.t,
      bar.o,
      bar.h,
      bar.l,
      bar.c
    ]);

    const volume = bars.map(bar => [bar.t, bar.v]);

    const chartOptions: Highcharts.Options = {
      chart: {
        animation: false,
        backgroundColor: 'transparent',
        marginRight: 54,
        style: { fontFamily: 'inherit' },
        events: { load() { this.container.querySelector('svg')?.setAttribute('aria-label', `${ticker} historical prices and trading volume`); } },
      },
      rangeSelector: { enabled: false },
      title: { text: '' },
      plotOptions: { series: { animation: false } },
      legend: {
        enabled: false
      },
      xAxis: {
        type: 'datetime',
        min: this.historyRangeStart(this.historyRange ?? '1M'),
        max: this.historyEnd,
        events: { afterSetExtremes: event => { if (event.trigger === 'navigator') this.historyRange = null; } },
        dateTimeLabelFormats: {
          month: '%b \'%y',
          day: '%e %b',
        }
      },
      yAxis: [{
        startOnTick: false,
        endOnTick: false,
        labels: {
          align: 'left',
          x: 5
        },
        title: {
          text: undefined
        },
        height: '60%',
        lineWidth: 2,
        resize: {
          enabled: true
        }
      }, {
        labels: {
          align: 'left',
          x: 5
        },
        title: {
          text: undefined
        },
        top: '65%',
        height: '35%',
        offset: 0,
        lineWidth: 2
      }],

      tooltip: {
        split: false,
        xDateFormat: '%A, %d %b %Y',
      },
      exporting: {
        enabled: false,
      },

      series: [{
        type: 'candlestick',
        name: `${ticker}`,
        id: 'aapl',
        zIndex: 2,
        color: '#a1324b',
        upColor: '#245adb',
        lineColor: '#a1324b',
        upLineColor: '#245adb',
        data: ohlc
      }, {
        type: 'column',
        name: 'Volume',
        id: 'volume',
        color: '#8bacef',
        data: volume,
        yAxis: 1
      }, {
        type: 'vbp',
        name: 'Volume by price',
        linkedTo: 'aapl',
        params: {
          volumeSeriesID: 'volume'
        },
        dataLabels: {
          enabled: false
        },
        zoneLines: {
          enabled: false
        },
        volumeDivision: {
          styles: {
            positiveColor: 'rgba(36, 90, 219, .24)',
            negativeColor: 'rgba(161, 50, 75, .20)',
          },
        }
      }, {
        type: 'sma',
        linkedTo: 'aapl',
        zIndex: 1,
        color: '#677ca0',
        marker: {
          enabled: false
        }
      }],
      navigator: {
        enabled: true,
        series: {
          color: '#245adb',
          fillColor: {
            linearGradient: {
              x1: 0, y1: 0, x2: 0, y2: 1
            },
            stops: [
              [0, 'rgba(36, 90, 219, .32)'],
              [1, 'rgba(36, 90, 219, .06)']
            ]
          },
        },
      },
      responsive: {
        rules: [{ condition: { maxWidth: 425 }, chartOptions: { navigator: { enabled: false }, scrollbar: { enabled: false } } }],
      },
    };
    return chartOptions;
  }

  private historyRangeStart(range: HistoryRange): number | undefined {
    if (this.historyStart === null || this.historyEnd === null) return undefined;
    const end = new Date(this.historyEnd);
    const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };
    const start = range === 'All' ? this.historyStart
      : range === 'YTD' ? Date.UTC(end.getUTCFullYear(), 0, 1)
      : utcDayMonthsBefore(this.historyEnd, months[range]);
    return Math.max(this.historyStart, start);
  }

  selectHistoryRange(range: HistoryRange): void {
    this.updateHistoryRange(range);
    this.updateViewQuery();
  }

  private updateHistoryRange(range: HistoryRange): void {
    this.historyRange = range;
    if (this.historyEnd === null) return;
    this.bigChartOptions = {
      ...this.bigChartOptions,
      xAxis: { ...this.bigChartOptions.xAxis, min: this.historyRangeStart(range), max: this.historyEnd },
    };
  }

  getHistoricalData(ticker: string, quote: QuoteResponse | null): Observable<AggregateBarResponse[]> {
    const latest = quote ? quote.t * 1000 : Date.now();
    const from = new Date(latest - (quote ? 1 : 4) * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(latest).toISOString().slice(0, 10);
    return this.http.get<{ results?: AggregateBarResponse[] }>('/company_OneDay_data', {
      params: { symbol: ticker, from, to }
    }).pipe(map(response => validClosingBars(response?.results)));
  }

  private renderOverview(): void {
    const range = this.overviewRange;
    const points = range === 'Hourly' ? this.hourlyBars : this.overviewDailyBars;
    const end = points?.at(-1);
    const months = { '1M': 1, '3M': 3, '1Y': 12 };
    const from = end && range !== 'Hourly' ? utcDayMonthsBefore(end.t, months[range]) : 0;
    const visible = points?.filter(point => point.t >= from) ?? [];
    const start = visible[0];
    this.overviewStart = start?.t ?? null;
    this.overviewEnd = end?.t ?? null;
    this.overviewReturn = start && end && visible.length > 1 ? (end.c / start.c - 1) * 100 : null;
    if (visible.length < 2) {
      this.chartOptions = {};
      return;
    }

    const seriesData = visible.map(point => [point.t, point.c]);
    const ticker = this.lastSuccessfulSearch ?? '';

    this.chartOptions = {
      title: { text: '' },
      legend: {
        enabled: false
      },
      plotOptions: {
        series: {
          animation: false,
          marker: {
            enabled: false
          }
        }
      },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 96,
        dateTimeLabelFormats: {
          hour: '%H:%M',
        }
      },
      yAxis: {
        title: {
          text: null
        },
        gridLineColor: '#e3eaf7',
        opposite: true,
        labels: { x: 6 },
      },
      chart: {
        animation: false,
        backgroundColor: 'transparent',
        style: { fontFamily: 'inherit' },
      },
      accessibility: { description: `${ticker} ${range === 'Hourly' ? 'hourly' : 'daily'} closing prices from Polygon.` },
      exporting: {
        enabled: false,
      },
      series: [{
        name: ticker,
        data: seriesData,
        type: 'area',
        color: '#245adb',
        fillColor: {
          linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
          stops: [[0, 'rgba(36, 90, 219, .20)'], [1, 'rgba(36, 90, 219, .01)']],
        },
        threshold: null,
        tooltip: {
          valueDecimals: 2
        }
      }]
    };
  }

  ngOnDestroy(): void {
    this.searchSubscription.unsubscribe();
    this.tradeModal?.close();
    this.newsModal?.close();
    clearTimeout(this.confirmationTimeout);
  }

  setupAutoUpdate(): void {
    interval(30000).pipe(
      switchMap(() => {
        const ticker = this.lastSuccessfulSearch;
        if (!ticker || document.hidden) return of(null);
        const context = this.searchSubscription;
        return this.getLatestQuote(ticker).pipe(
          map(quote => ({ ticker, quote, context })),
          catchError(() => of(null))
        );
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(update => {
      if (update?.quote && update.context === this.searchSubscription) {
        const hadQuote = !!this.currentStock;
        this.currentStock = update.quote;
        if (!hadQuote && this.activeTab === 'summary' && this.overviewRange === 'Hourly') this.loadOverview();
      }
    });
  }

  setupSearch(): void {
    this.filteredOptions = this.tickerFormControl.valueChanges.pipe(
      map(value => typeof value === 'string' ? value.trim() : ''),
      debounceTime(250),
      distinctUntilChanged(),
      switchMap(term => {
        this.suggestionsError = false;
        if (!term) return of([]);
        this.isLoading = true;
        return this.getStocks(term).pipe(
          catchError(() => {
            this.suggestionsError = true;
            return of([]);
          }),
          finalize(() => this.isLoading = false)
        );
      })
    );
  }

  getStocks(term: string): Observable<StockResult[]> {
    return this.http.get<{ result: StockResult[] }>('/Autocomplete_Search', { params: { symbol: term } }).pipe(
      map(response => (response.result ?? []).slice(0, 10))
    );
  }

  getStockDetails(ticker: string): Observable<CompanyProfile> {
    return this.http.get<CompanyProfile>('/company_profile', { params: { symbol: ticker } });
  }

  submitSearch(selection: StockResult | string = this.tickerFormControl.value): void {
    const ticker = this.displayFn(selection).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(ticker)) {
      this.searchError = ticker ? 'Enter a valid ticker such as AAPL or BRK.B.' : 'Enter a ticker to start your search.';
      return;
    }
    if (this.route.snapshot.paramMap.get('ticker') === ticker) {
      this.loadSearch(ticker);
      this.syncResearchView();
    } else {
      void this.router.navigate(['/search-details', ticker]);
    }
  }

  private resetSearch(): void {
    this.searchSubscription.unsubscribe();
    this.searchSubscription = new Subscription();
    this.loadedTabs.clear();
    this.loadingTabs.clear();
    this.failedTabs.clear();
    this.lastSuccessfulSearch = null;
    this.DetailIsLoading = false;
    this.quoteLoading = false;
    this.searchError = '';
    this.searchResults = null;
    this.currentStock = null;
    this.isFavorited = false;
    this.watchlistUnavailable = false;
    this.companyPeers = [];
    this.hourlyLoading = false;
    this.hourlyFailed = false;
    this.hourlyBars = null;
    this.overviewDailyBars = null;
    this.overviewDailyLoading = false;
    this.overviewDailyFailed = false;
    this.overviewStart = null;
    this.overviewEnd = null;
    this.overviewReturn = null;
    this.topNews = [];
    this.visibleNewsCount = 12;
    this.earnings = [];
    this.recommendations = [];
    this.sentiments = null;
    this.ownedStockQuantity = 0;
    this.activeTab = 'summary';
    this.tradeModal?.close();
    this.newsModal?.close();
    this.selectedNewsItem = null;
    this.chartOptions = {};
    this.bigChartOptions = {};
    this.historyRange = '1M';
    this.historyStart = null;
    this.historyEnd = null;
    this.trendChartOptions = {};
    this.earningChartOptions = {};
    this.closeConfirmation();
  }

  private loadSearch(value: string): void {
    this.resetSearch();
    const ticker = value.trim().toUpperCase();
    this.tickerFormControl.setValue(ticker, { emitEvent: false });
    if (!/^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(ticker)) {
      this.searchError = 'Enter a valid ticker such as AAPL or BRK.B.';
      return;
    }

    this.DetailIsLoading = true;
    this.quoteLoading = true;
    this.searchSubscription.add(this.getStockDetails(ticker).pipe(
      finalize(() => this.DetailIsLoading = false),
    ).subscribe({
      next: profile => {
        if (!profile?.ticker) {
          this.searchError = `No company found for ${ticker}. Try another ticker.`;
          return;
        }

        this.lastSuccessfulSearch = ticker;
        const currency = typeof profile.currency === 'string' ? profile.currency.toUpperCase() : '';
        this.searchResults = { ...profile, currency: /^[A-Z]{3}$/.test(currency) ? currency : '' };
        this.loadSummary(ticker);
        this.loadActiveView();
        this.checkWatchlistStatus();
        this.refreshHolding(ticker);
      },
      error: (error: HttpErrorResponse) => {
        this.searchError = error.status === 404
          ? `No company found for ${ticker}. Try another ticker.`
          : 'Company data is temporarily unavailable. Please try again.';
      }
    }));
    this.searchSubscription.add(this.getLatestQuote(ticker).pipe(
      catchError(() => of(null)),
      finalize(() => {
        this.quoteLoading = false;
        if (!this.searchSubscription.closed && this.lastSuccessfulSearch === ticker
          && this.activeTab === 'summary' && this.overviewRange === 'Hourly') this.loadOverview();
      }),
    ).subscribe(quote => {
      this.currentStock = quote;
    }));
  }

  private loadSummary(ticker: string): void {
    this.searchSubscription.add(this.getCompanyPeers(ticker).subscribe({
      next: peers => this.companyPeers = Array.isArray(peers) ? peers : [],
      error: () => this.companyPeers = [],
    }));
  }

  private loadHourly(ticker: string): void {
    if (this.quoteLoading || this.hourlyLoading || this.hourlyBars) return;
    this.hourlyLoading = true;
    this.hourlyFailed = false;
    this.searchSubscription.add(this.getHistoricalData(ticker, this.currentStock).pipe(
      finalize(() => this.hourlyLoading = false),
    ).subscribe({
      next: hourly => {
        this.hourlyBars = hourly;
        if (this.overviewRange === 'Hourly') this.renderOverview();
      },
      error: () => this.hourlyFailed = true,
    }));
  }

  loadOverview(): void {
    const ticker = this.lastSuccessfulSearch;
    if (!ticker) return;
    if (this.overviewRange === 'Hourly') {
      this.loadHourly(ticker);
      return;
    }
    if (this.overviewDailyLoading || this.overviewDailyBars) return;
    this.overviewDailyFailed = false;
    this.overviewDailyLoading = true;
    this.searchSubscription.add(this.getBigChartData(ticker).pipe(
      finalize(() => this.overviewDailyLoading = false),
    ).subscribe({
      next: ({ results }) => {
        this.overviewDailyBars = results;
        if (this.overviewRange !== 'Hourly') this.renderOverview();
      },
      error: () => this.overviewDailyFailed = true,
    }));
  }

  selectOverviewRange(range: OverviewRange): void {
    if (this.overviewRange === range) return;
    this.overviewRange = range;
    this.renderOverview();
    this.loadOverview();
    this.updateViewQuery();
  }

  private syncResearchView(): void {
    const ticker = this.route.snapshot.paramMap.get('ticker');
    if (ticker !== this.requestedTicker) {
      this.requestedTicker = ticker;
      if (ticker) this.loadSearch(ticker);
      else {
        this.resetSearch();
        this.tickerFormControl.setValue('');
      }
    }

    const query = this.route.snapshot.queryParamMap;
    const tab = this.detailTabs.find(item => item.id === query.get('view'))?.id ?? 'summary';
    const range = overviewRanges.find(item => item.toLowerCase() === query.get('range')) ?? '1M';
    const history = historyRanges.find(item => item.toLowerCase() === query.get('history')) ?? '1M';
    const viewChanged = tab !== this.activeTab || range !== this.overviewRange;
    this.activeTab = tab;
    if (range !== this.overviewRange) {
      this.overviewRange = range;
      this.renderOverview();
    }
    if (history !== this.historyRange) this.updateHistoryRange(history);
    if (viewChanged) this.loadActiveView();
  }

  private updateViewQuery(): void {
    const history = this.historyRange?.toLowerCase() ?? this.route.snapshot.queryParamMap.get('history');
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        view: this.activeTab === 'summary' ? null : this.activeTab,
        range: this.overviewRange === '1M' ? null : this.overviewRange.toLowerCase(),
        history: history === '1m' ? null : history,
      },
      queryParamsHandling: 'merge',
      preserveFragment: true,
    });
  }

  handleTabKey(event: KeyboardEvent, index: number): void {
    const count = this.detailTabs.length;
    const next = event.key === 'ArrowRight' ? (index + 1) % count
      : event.key === 'ArrowLeft' ? (index + count - 1) % count
      : event.key === 'Home' ? 0
      : event.key === 'End' ? count - 1 : null;
    if (next === null) return;
    event.preventDefault();
    this.setActiveTab(this.detailTabs[next].id);
    const tab = event.currentTarget as HTMLButtonElement;
    tab.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  openHistory(): void {
    this.setActiveTab('charts');
    document.getElementById('research-tab-charts')?.focus();
  }

  setActiveTab(tabName: DetailTab): void {
    const changed = this.activeTab !== tabName;
    this.activeTab = tabName;
    this.loadActiveView();
    if (changed) this.updateViewQuery();
  }

  private loadActiveView(): void {
    const tabName = this.activeTab;
    if (tabName === 'summary') {
      this.loadOverview();
      return;
    }
    const ticker = this.lastSuccessfulSearch;
    if (!ticker || this.loadingTabs.has(tabName) || this.loadedTabs.has(tabName)) return;

    this.loadingTabs.add(tabName);
    this.failedTabs.delete(tabName);
    let request: Observable<unknown>;
    switch (tabName) {
      case 'news':
        request = this.getTopNews(ticker).pipe(tap(news => this.topNews = news));
        break;
      case 'charts':
        request = this.getBigChartData(ticker).pipe(tap(daily => {
          if (Array.isArray(daily?.results) && daily.results.length) this.bigChartOptions = this.createBigChart(daily, ticker);
        }));
        break;
      case 'insights':
        request = forkJoin({
          earnings: this.getEarnings(ticker).pipe(catchError(() => of(null))),
          sentiment: this.getSentiments(ticker).pipe(catchError(() => of(null))),
          recommendations: this.getRecommendations(ticker).pipe(catchError(() => of(null))),
        }).pipe(tap(({ earnings, sentiment, recommendations }) => {
          if (!earnings && !sentiment && !recommendations) throw new Error('Insights unavailable');
          this.earnings = earnings ?? [];
          this.recommendations = recommendations ?? [];
          this.sentiments = sentiment;
          this.calculateSummary();
          if (this.earnings.length || this.recommendations.length) this.createInsightChart();
        }));
        break;
    }
    this.searchSubscription.add(request.pipe(
      finalize(() => this.loadingTabs.delete(tabName)),
    ).subscribe({
      next: () => this.loadedTabs.add(tabName),
      error: () => this.failedTabs.add(tabName),
    }));
  }

  clearSearch(): void {
    this.tickerFormControl.setValue('');
    this.searchError = '';
  }

  checkWatchlistStatus(): void {
    const ticker = this.lastSuccessfulSearch;
    if (!ticker || this.watchlistLoading || this.watchlistPending) return;
    this.watchlistUnavailable = false;
    this.watchlistLoading = true;
    this.searchSubscription.add(this.portfolioService.checkWatchlist(ticker).pipe(
      finalize(() => this.watchlistLoading = false),
    ).subscribe({
      next: favorited => this.isFavorited = favorited,
      error: () => this.watchlistUnavailable = true,
    }));
  }

  getLatestQuote(ticker: string): Observable<QuoteResponse | null> {
    return this.http.get<QuoteResponse>('/company_quote', { params: { symbol: ticker } }).pipe(
      map(quote => quote && Number.isFinite(quote.c) && quote.c > 0
        && Number.isFinite(quote.t) && quote.t > 0 ? quote : null),
    );
  }

  getCompanyPeers(ticker: string): Observable<string[]> {
    const url = `/company_peers?symbol=${ticker}`;
    return this.http.get<string[]>(url);
  }


  toggleFavorite(): void {
    const ticker = this.lastSuccessfulSearch;
    if (!ticker || this.watchlistLoading || this.watchlistPending || this.watchlistUnavailable) return;

    const adding = !this.isFavorited;
    const context = this.searchSubscription;
    this.watchlistPending = true;
    const request = adding
      ? this.portfolioService.addWatchlist(ticker)
      : this.portfolioService.removeWatchlist(ticker);
    request.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => {
        this.watchlistPending = false;
        if (this.searchSubscription !== context && !this.searchSubscription.closed) this.checkWatchlistStatus();
      })
    ).subscribe({
      next: () => {
        if (this.searchSubscription === context) {
          this.isFavorited = adding;
          this.showConfirmationMessage(adding ? `${ticker} added to your watchlist.` : `${ticker} removed from your watchlist.`);
        }
      },
      error: () => {
        if (this.searchSubscription === context) {
          this.showConfirmationMessage('Could not update your watchlist. Please try again.', true);
        }
      },
    });
  }

  closeConfirmation(): void {
    this.showConfirmation = false;
  }

  displayFn(selection: StockResult | string): string {
    return typeof selection === 'string' ? selection : selection?.displaySymbol ?? '';
  }

  getChangeColor(stock: QuoteResponse): string {
    return stock.dp > 0 ? '#2254dc' : stock.dp < 0 ? '#b4233c' : '#293950';
  }

  formatChangeValue(quote: QuoteResponse | null): string {
    if (!quote || !Number.isFinite(quote.d)) return '—';
    return `${quote.d >= 0 ? '+' : ''}${quote.d.toFixed(2)}`;
  }

  formatChangePercent(quote: QuoteResponse | null): string {
    if (!quote || !Number.isFinite(quote.dp)) return '—';
    return `${quote.dp.toFixed(2)}%`;
  }

}
