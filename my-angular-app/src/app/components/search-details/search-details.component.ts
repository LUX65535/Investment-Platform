import { Component, DestroyRef, ElementRef, inject, OnDestroy, OnInit, TemplateRef } from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { EMPTY, Observable, Subject, of, Subscription, exhaustMap, forkJoin, merge, timer } from 'rxjs';
import { catchError, filter, finalize, map, retry, startWith, switchMap, takeUntil, tap } from 'rxjs/operators';
import { ActivatedRoute, NavigationEnd, Router, RouterModule } from '@angular/router';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatAutocompleteModule, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HighchartsChartModule } from 'highcharts-angular';
import type * as Highcharts from 'highcharts/highstock';
import { ChartSelection, MarketResearchChartComponent, defaultStudies } from '../market-research-chart/market-research-chart.component';
import { researchRanges, researchIntervals, intervalReason, defaultInterval } from '../market-research-chart/market-studies';
import { ResearchLandingComponent } from '../research-landing/research-landing.component';
import { ResearchQuickSwitchComponent } from './research-quick-switch.component';
import { ResearchRecentsService } from '../../services/research-recents.service';
import { estimateOrderCents, paperOrderConfirmation, PendingOrderError, PendingPaperOrder, PortfolioService, ReferenceQuoteRequired } from '../../services/portfolio.service';
import { MarketBar as AggregateBarResponse, MarketHistoryService, alignedPriceReturns, utcDayMonthsBefore, validClosingBars } from '../../services/market-history.service';
import { MarketQuote, MarketQuoteService, QuoteSnapshot, quoteRefreshMs } from '../../services/market-quote.service';
import { activeRefreshes, dailyRefreshes, retryAfterTime } from '../../services/market-refresh';

type QuoteResponse = MarketQuote;

export interface StockResult {
  displaySymbol: string;
  description: string;
  symbol: string;
  type: string;
}
export interface CompanyProfile {
  instrumentType?: string;
  country: string;
  currency: string;
  exchange: string;
  name: string;
  ticker: string;
  ipo: string;
  marketCapitalization?: number;
  shareOutstanding?: number;
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
  relevance: number;
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
type PriceRequest = 'hourly' | 'daily' | 'benchmark';
type InsightSection = 'earnings' | 'sentiment' | 'recommendations';
const uncertainOrderMessage = 'The order may have filled. Check your receipts in Portfolio or retry the same order.';
const tickerPattern = /^[A-Z0-9][A-Z0-9.:-]{0,24}$/;

interface SuggestionRequest {
  term: string;
  submitted: boolean;
  openOptions?: () => void;
}

@Component({
  selector: 'app-search-details',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule, RouterModule, NgbModule,
    MatAutocompleteModule, MatInputModule, MatProgressSpinnerModule, HighchartsChartModule,
    ResearchLandingComponent, ResearchQuickSwitchComponent, MarketResearchChartComponent,
  ],
  templateUrl: './search-details.component.html',
  styleUrls: ['./search-details.component.css', './search-details-news.css', './search-details-mobile.css', './search-details-comparison.css'],
})
export class SearchDetailsComponent implements OnInit, OnDestroy {
  researchSelection: ChartSelection = { range: '1M', interval: '1d' };
  researchStudies = defaultStudies();
  setResearchComparison(symbol: string | null): void {
    this.comparisonTicker = symbol;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { compare: symbol?.toLowerCase() ?? null }, queryParamsHandling: 'merge', preserveFragment: true });
  }
  setResearchSelection(selection: ChartSelection): void {
    this.researchSelection = selection;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { range: selection.range.toLowerCase(), interval: selection.interval }, queryParamsHandling: 'merge', preserveFragment: true });
  }

  tickerFormControl = new FormControl<string | StockResult>('', { nonNullable: true });
  searchOptions: StockResult[] = [];
  searchFeedback = '';
  private readonly searchRequests = new Subject<SuggestionRequest>();
  isLoading = false;
  searchSubmitting = false;
  DetailIsLoading = false;
  quoteLoading = false;
  quoteRefreshFailed = false;
  private readonly marketQuotes = inject(MarketQuoteService);
  private readonly document = inject(DOCUMENT);
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
  comparisonTicker: string | null = null;
  comparisonPickerOpen = false;
  comparisonInputError = '';
  benchmarkLoading = false;
  benchmarkFailed = false;
  benchmarkUnavailable = '';
  benchmarkResult: { start: number; end: number; stock: number; comparison: number } | null = null;
  private benchmarkBars: AggregateBarResponse[] | null = null;
  private benchmarkRequest?: Subscription;
  private hourlyBars: AggregateBarResponse[] | null = null;
  private overviewDailyBars: AggregateBarResponse[] | null = null;
  private overviewDailyLoading = false;
  private overviewDailyFailed = false;
  private priceRetryAt: Record<PriceRequest, number> = { hourly: 0, daily: 0, benchmark: 0 };
  private retryNow = Date.now();
  private retryClock?: Subscription;
  private requestedTicker: string | null = null;
  readonly loadingTabs = new Set<DetailTab>();
  readonly failedTabs = new Set<DetailTab>();
  private readonly loadedTabs = new Set<DetailTab>();
  readonly failedInsights = new Set<InsightSection>();
  private readonly loadedInsights = new Set<InsightSection>();
  readonly detailTabs: ReadonlyArray<{ id: DetailTab; label: string }> = [
    { id: 'summary', label: 'Overview' },
    { id: 'news', label: 'Top News' },
    { id: 'charts', label: 'Charts' },
    { id: 'insights', label: 'Insights' },
  ];
  private readonly destroyRef = inject(DestroyRef);
  private readonly recents = inject(ResearchRecentsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private searchSubscription = new Subscription();
  activeTab: DetailTab = 'summary';
  searchResults: CompanyProfile | null = null;
  companyLogoReady = false;


  private lastSuccessfulSearch: string | null = null;
  private confirmationTimeout?: ReturnType<typeof setTimeout>;

  currentStock: QuoteResponse | null = null;
  companyPeers: string[] = [];

  chartRuntime?: typeof Highcharts;
  chartRuntimeUnavailable = false;
  private chartRuntimeRequested = false;
  private destroyed = false;
  chartOptions: Highcharts.Options = {};
  trendChartOptions: Highcharts.Options = {};
  earningChartOptions: Highcharts.Options = {};



  isFavorited: boolean = false;


  topNews: TopNews[] = [];
  alternateNews?: TopNews;
  visibleNewsCount = 12;
  selectedNewsItem: TopNews | null = null;

  bigChartOptions: Highcharts.Options = {};
  readonly historyRanges = historyRanges;
  historyRange: HistoryRange | null = '1M';
  showSma = false;
  smaAvailable = false;
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
  tradeReference?: ReferenceQuoteRequired;
  referenceAcknowledged = false;
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

  get overviewRetrySeconds(): number {
    return this.priceRetrySeconds(this.overviewRange === 'Hourly' ? 'hourly' : 'daily');
  }

  get benchmarkRetrySeconds(): number {
    return this.priceRetrySeconds('benchmark');
  }

  get activeTabRetrySeconds(): number {
    return this.activeTab === 'charts' ? this.priceRetrySeconds('daily') : 0;
  }

  get insightsAvailable(): boolean {
    return this.loadedInsights.size > 0;
  }

  private priceRetrySeconds(request: PriceRequest): number {
    return Math.max(0, Math.ceil((this.priceRetryAt[request] - this.retryNow) / 1000));
  }

  private recordPriceFailure(request: PriceRequest, error: HttpErrorResponse): void {
    this.retryNow = Date.now();
    this.priceRetryAt[request] = retryAfterTime(error.headers?.get('Retry-After') ?? null, this.retryNow) ?? 0;
    if (!this.priceRetrySeconds(request) || (this.retryClock && !this.retryClock.closed)) return;
    this.retryClock = timer(1000, 1000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.retryNow = Date.now();
      if (Object.values(this.priceRetryAt).every(until => until <= this.retryNow)) {
        this.retryClock?.unsubscribe();
        this.retryClock = undefined;
      }
    });
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
    this.tradeReference = undefined;
    this.referenceAcknowledged = false;
    this.tradeSide = side;
    this.tradeQuantity = pending?.quantity ?? 1;
    this.tradeError = pending ? uncertainOrderMessage : '';
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
    const cents = this.estimatedTradeCents;
    return Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : 0;
  }

  private get estimatedTradeCents(): number {
    return estimateOrderCents(this.tradeReference?.quote.price ?? this.currentStock?.c ?? 0, this.tradeQuantity ?? 0);
  }

  get tradeLimitMessage(): string {
    const quantity = this.tradeQuantity;
    if (this.tradePending || this.tradeNeedsRefresh || quantity === null) return '';
    if (!Number.isSafeInteger(quantity) || quantity < 1) return 'Enter a whole number of shares.';
    const cents = this.estimatedTradeCents;
    if (!Number.isSafeInteger(cents) || cents < 1) return 'Enter a quantity with an estimated total of at least $0.01.';
    if (this.tradeSide === 'sell' && quantity > this.ownedStockQuantity) return 'You have fewer shares available to sell.';
    if (this.tradeSide === 'buy' && this.walletInitialized && cents > Math.round(this.userWalletBalance * 100)) {
      return 'The estimated total exceeds your buying power.';
    }
    return '';
  }

  get canSubmitTrade(): boolean {
    const quantity = this.tradeQuantity ?? 0;
    if (this.tradePending || !Number.isSafeInteger(quantity) || quantity < 1) return false;
    if (this.tradeNeedsRefresh) return true;
    if (this.tradeReference && !this.referenceAcknowledged) return false;
    return this.supportsPaperTrade && !this.walletLoading && !this.tradeLimitMessage
      && (this.tradeSide === 'sell' || this.walletInitialized === true);
  }

  submitTrade(): void {
    const ticker = this.lastSuccessfulSearch;
    const quantity = this.tradeQuantity;
    if (!this.canSubmitTrade || !ticker || !quantity) return;

    const side = this.tradeSide;
    const context = this.searchSubscription;
    this.tradePending = true;
    this.tradeError = '';
    const trade = this.tradeReference
      ? this.portfolioService.confirmReferenceQuote(this.tradeReference)
      : this.pendingTrade
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
      error: (error: unknown) => {
        if (this.searchSubscription !== context) return;
        this.tradeReference = error instanceof ReferenceQuoteRequired ? error : undefined;
        this.referenceAcknowledged = false;
        this.pendingTrade = error instanceof PendingOrderError ? error.order : undefined;
        this.tradeNeedsRefresh = Boolean(this.pendingTrade);
        if (this.tradeNeedsRefresh) {
          this.refreshHolding(ticker);
          this.tradeError = uncertainOrderMessage;
        } else if (!this.tradeReference) {
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
    const company = this.searchResults?.name ?? '';
    const compactName = company.replace(/(?:,?\s+)(?:incorporated|inc\.?|corp\.?|corporation|company|co\.?|limited|ltd\.?|plc)$/i, '').trim();
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameMatch = compactName.length >= 3
      ? new RegExp(`\\b${escape(compactName)}\\b`, 'i') : null;
    const tickerMatch = ticker.length > 1
      ? new RegExp(`(?:^|[^A-Za-z0-9])\\$?${escape(ticker)}(?=$|[^A-Za-z0-9])`) : null;
    const mentionsCompany = (text: string) => Boolean(nameMatch?.test(text) || tickerMatch?.test(text));
    return this.http.get<unknown>('/company_news', { params: { symbol: ticker } }).pipe(
      map(payload => {
        if (!Array.isArray(payload)) throw new Error('Unexpected news response');

        const articles: TopNews[] = [];
        for (const item of payload) {
          const headline = this.newsText(item?.headline);
          const url = this.httpsUrl(item?.url);
          if (!headline || !url) continue;

          const summary = this.newsText(item.summary);
          articles.push({
            headline, url, image: this.httpsUrl(item.image), imageReady: false,
            source: this.newsText(item.source) || new URL(url).hostname,
            summary,
            relevance: mentionsCompany(headline) ? 2 : mentionsCompany(summary) ? 1 : 0,
            datetime: Number.isFinite(item.datetime) && item.datetime > 0 && item.datetime < 4_102_444_800
              ? item.datetime : 0,
          });
        }

        const seenUrls = new Set<string>();
        const seenHeadlines = new Set<string>();
        const latest = articles.sort((a, b) => b.relevance - a.relevance || b.datetime - a.datetime).filter(article => {
          const key = article.headline.toLowerCase();
          if (seenUrls.has(article.url) || seenHeadlines.has(key)) return false;
          seenUrls.add(article.url);
          seenHeadlines.add(key);
          return true;
        }).slice(0, 40);
        const seenImages = new Set<string>();
        return latest.map(article => {
          if (!article.image) return article;
          const image = new URL(article.image);
          const key = image.origin + image.pathname;
          const isYahooBranding = image.hostname === 's.yimg.com' && image.pathname.startsWith('/rz/stage/p/');
          if (isYahooBranding || seenImages.has(key)) article.image = '';
          else seenImages.add(key);
          return article;
        });
      })
    );
  }

  private setNews(articles: TopNews[]): void {
    const lead = articles[0];
    this.alternateNews = lead && !lead.image ? articles.find((article, index) =>
      index > 0 && article.relevance > 0 && article.image && article.source !== lead.source &&
      article.datetime >= lead.datetime - 36 * 60 * 60
    ) : undefined;
    this.topNews = this.alternateNews ? articles.filter(article => article !== this.alternateNews) : articles;
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

  async validateNewsImage(event: Event, article: TopNews): Promise<void> {
    const image = event.target as HTMLImageElement;
    const ratio = image.naturalWidth / image.naturalHeight;
    if (image.naturalWidth < 160 || image.naturalHeight < 90 || ratio > 3.5 || ratio < .65) {
      this.discardNewsImage(article);
      return;
    }
    try {
      await image.decode();
      if (image.isConnected) article.imageReady = true;
    } catch {
      this.discardNewsImage(article);
    }
  }

  async validateCompanyLogo(event: Event): Promise<void> {
    const image = event.target as HTMLImageElement;
    if (image.naturalWidth < 24 || image.naturalHeight < 24) return;
    const source = image.currentSrc;
    try {
      await image.decode();
      if (image.isConnected && image.currentSrc === source) this.companyLogoReady = true;
    } catch {
      // Keep the ticker monogram until an image can actually be painted.
    }
  }

  discardNewsImage(article: TopNews): void {
    article.image = '';
    article.imageReady = false;
  }

  trackNews(_index: number, article: TopNews): string {
    return article.url;
  }

  showMoreNews(): void {
    // The latest story is displayed separately, so article index n is row n in the remaining list.
    const firstNewRow = this.visibleNewsCount;
    this.visibleNewsCount = Math.min(this.visibleNewsCount + 12, this.topNews.length);
    requestAnimationFrame(() => {
      this.host.nativeElement.querySelector<HTMLButtonElement>(`.news-list li:nth-child(${firstNewRow}) .news-row`)?.focus();
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
  getBigChartData(ticker: string, refresh = false): Observable<{ results: AggregateBarResponse[] }> {
    return this.marketHistory.daily(ticker, refresh);
  }
  createBigChart(data: { results: AggregateBarResponse[] }, ticker: string): Highcharts.Options {
    const bars = data.results.filter(bar => bar && [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite))
      .sort((a, b) => a.t - b.t);
    if (!bars.length) return {};
    this.smaAvailable = bars.length >= 20;
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
        name: 'SMA 20',
        id: 'sma-20',
        linkedTo: 'aapl',
        params: { period: 20, index: 3 },
        visible: this.showSma && this.smaAvailable,
        zIndex: 3,
        color: '#7653a6',
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

  toggleSma(): void {
    if (!this.smaAvailable) return;
    this.showSma = !this.showSma;
    this.bigChartOptions = {
      ...this.bigChartOptions,
      series: this.bigChartOptions.series?.map(series => series.id === 'sma-20'
        ? { ...series, visible: this.showSma } : series),
    };
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
      this.benchmarkResult = null;
      this.chartOptions = {};
      return;
    }

    const seriesData = visible.map(point => [point.t, point.c]);
    const ticker = this.lastSuccessfulSearch ?? '';
    const comparison = this.comparisonTicker;
    const aligned = comparison && range !== 'Hourly' && this.benchmarkBars
      ? alignedPriceReturns(visible, this.benchmarkBars) : [];
    this.benchmarkResult = null;
    if (comparison && aligned.length >= 2) {
      this.renderBenchmark(ticker, comparison, aligned);
      return;
    }

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
      accessibility: { description: `${ticker} ${range === 'Hourly' ? 'hourly' : 'daily'} closing prices from Massive (Polygon).` },
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

  private renderBenchmark(ticker: string, symbol: string, aligned: Array<[number, number, number]>): void {
    const [end, stock, comparison] = aligned[aligned.length - 1];
    this.benchmarkResult = { start: aligned[0][0], end, stock, comparison };
    this.chartOptions = {
      title: { text: '' },
      chart: { animation: false, backgroundColor: 'transparent', style: { fontFamily: 'inherit' } },
      xAxis: { type: 'datetime', crosshair: true, tickPixelInterval: 100 },
      yAxis: {
        title: { text: null }, opposite: true, gridLineColor: '#e3eaf7', labels: { format: '{value}%' },
        plotLines: [{ value: 0, color: '#a9b7cd', width: 1 }],
      },
      tooltip: { shared: true, valueSuffix: '%', valueDecimals: 2 },
      plotOptions: { series: { animation: false, marker: { enabled: false } } },
      legend: { enabled: false },
      accessibility: { description: `${ticker} and ${symbol} price returns on matching trading days, rebased to zero.` },
      exporting: { enabled: false },
      series: [
        { type: 'line', name: ticker, color: '#245adb', lineWidth: 2.5, data: aligned.map(([day, value]) => [day, value]) },
        { type: 'line', name: symbol, color: '#75649f', dashStyle: 'ShortDash', data: aligned.map(([day, , value]) => [day, value]) },
      ],
    };
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.searchSubscription.unsubscribe();
    this.retryClock?.unsubscribe();
    this.tradeModal?.close();
    this.newsModal?.close();
    clearTimeout(this.confirmationTimeout);
  }

  setupAutoUpdate(): void {
    activeRefreshes(this.document, quoteRefreshMs).pipe(
      exhaustMap(() => {
        const ticker = this.lastSuccessfulSearch;
        if (!ticker || this.quoteLoading || this.tradeModal || this.tradePending) return EMPTY;
        const context = this.searchSubscription;
        return this.getLatestQuote(ticker).pipe(map(snapshot => ({ ...snapshot, context })));
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(update => {
      if (update.context === this.searchSubscription) {
        this.quoteRefreshFailed = update.previous || !update.quote;
        if (!update.quote) return;
        const previousQuote = this.currentStock;
        this.currentStock = update.quote;
        const nextDay = !previousQuote || Math.floor(previousQuote.t / 86_400) !== Math.floor(update.quote.t / 86_400);
        if (nextDay) this.hourlyBars = null;

      }
    });

  }

  setupSearch(): void {
    const typedSearches = this.tickerFormControl.valueChanges.pipe(
      map(value => typeof value === 'string' ? value.trim() : ''),
      map((term): SuggestionRequest => ({ term, submitted: false })),
    );
    let lastLookup: { term: string; options: StockResult[] } | undefined;
    merge(typedSearches, this.searchRequests).pipe(
      switchMap(request => {
        const { term, submitted } = request;
        this.searchOptions = [];
        this.searchError = '';
        this.searchFeedback = '';
        this.suggestionsError = false;
        if (!term || term.length > 80) {
          lastLookup = undefined;
          if (submitted) this.searchError = term ? 'Enter up to 80 characters.' : 'Enter a company name or ticker to start your search.';
          return EMPTY;
        }

        const cached = lastLookup?.term === term ? lastLookup.options : undefined;
        this.isLoading = !cached;
        this.searchSubmitting = submitted && !cached;
        const options = cached ? of(cached) : (submitted ? of(0) : timer(250)).pipe(switchMap(() => this.getStocks(term)));
        return options.pipe(
          tap(results => {
            lastLookup = { term, options: results };
            this.searchOptions = results.slice(0, 10);
            if (submitted) this.resolveSubmittedSearch(request, results);
          }),
          catchError(() => {
            const ticker = term.toUpperCase();
            if (submitted && tickerPattern.test(ticker)) this.navigateToTicker(ticker);
            else this.suggestionsError = true;
            return EMPTY;
          }),
          finalize(() => {
            this.isLoading = false;
            this.searchSubmitting = false;
          })
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  getStocks(term: string): Observable<StockResult[]> {
    return this.http.get<{ result: StockResult[] }>('/Autocomplete_Search', { params: { symbol: term } }).pipe(
      map(response => Array.isArray(response?.result)
        ? response.result.filter(option => typeof option?.symbol === 'string'
          && typeof option.displaySymbol === 'string' && typeof option.description === 'string'
          && tickerPattern.test(option.symbol.trim().toUpperCase()))
        : [])
    );
  }

  getStockDetails(ticker: string): Observable<CompanyProfile> {
    return this.http.get<CompanyProfile>('/company_profile', { params: { symbol: ticker } });
  }

  submitSearch(selection: StockResult | string, input?: HTMLInputElement, trigger?: MatAutocompleteTrigger): void {
    if (typeof selection !== 'string') {
      this.navigateToTicker(selection.symbol.trim().toUpperCase());
      return;
    }
    if (this.searchSubmitting) return;
    const term = selection.trim();
    this.searchRequests.next({
      term,
      submitted: true,
      openOptions: input && trigger ? () => this.focusSearchOptions(input, trigger) : undefined,
    });
  }

  private focusSearchOptions(input: HTMLInputElement, trigger: MatAutocompleteTrigger): void {
    if (!input.isConnected) return;
    // CDK disables pointer events on a detached pane. Its fading node must not share
    // the listbox ID with the fresh panel when a user submits immediately after Escape.
    const oldPanel = input.ownerDocument.getElementById(trigger.autocomplete.id);
    if (!trigger.panelOpen && oldPanel?.parentElement?.style.pointerEvents === 'none') {
      oldPanel.hidden = true;
      oldPanel.removeAttribute('id');
    }
    input.focus();
    if (!trigger.panelOpen) trigger.openPanel();
  }

  private resolveSubmittedSearch(request: SuggestionRequest, options: StockResult[]): void {
    const ticker = request.term.toUpperCase();
    const normalizedName = (value: string) => value.toLowerCase().replace(/[.,]/g, '').trim().replace(/\s+/g, ' ');
    const canonicalSymbol = (option: StockResult) => option.symbol.trim().toUpperCase();
    if (options.some(option => canonicalSymbol(option) === ticker)) {
      this.navigateToTicker(ticker);
      return;
    }

    const companyName = normalizedName(request.term);
    const exact = new Set(options.filter(option => option.displaySymbol.trim().toUpperCase() === ticker
      || normalizedName(option.description) === companyName).map(canonicalSymbol));
    if (exact.size === 1) {
      this.navigateToTicker([...exact][0]);
    } else if (options.length) {
      this.searchFeedback = 'Choose a matching symbol from the suggestions.';
      request.openOptions?.();
    } else if (tickerPattern.test(ticker)) {
      this.navigateToTicker(ticker);
    } else {
      this.searchError = 'No matching companies found. Try another name or ticker.';
    }
  }

  private navigateToTicker(ticker: string): void {
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
    this.failedInsights.clear();
    this.loadedInsights.clear();
    this.retryClock?.unsubscribe();
    this.retryClock = undefined;
    this.retryNow = Date.now();
    this.priceRetryAt = { hourly: 0, daily: 0, benchmark: 0 };
    this.lastSuccessfulSearch = null;
    this.DetailIsLoading = false;
    this.quoteLoading = false;
    this.quoteRefreshFailed = false;
    this.searchError = '';
    this.searchResults = null;
    this.companyLogoReady = false;
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
    this.setComparison(null);
    this.comparisonPickerOpen = false;
    this.comparisonInputError = '';
    this.benchmarkResult = null;
    this.overviewStart = null;
    this.overviewEnd = null;
    this.overviewReturn = null;
    this.topNews = [];
    this.alternateNews = undefined;
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
    this.smaAvailable = false;
    this.historyStart = null;
    this.historyEnd = null;
    this.trendChartOptions = {};
    this.earningChartOptions = {};
    this.closeConfirmation();
  }

  private loadSearch(value: string): void {
    this.searchRequests.next({ term: '', submitted: false });
    this.resetSearch();
    const ticker = value.trim().toUpperCase();
    this.tickerFormControl.setValue(ticker, { emitEvent: false });
    if (!tickerPattern.test(ticker)) {
      this.searchError = 'Enter a valid ticker such as AAPL or BRK.B.';
      return;
    }

    this.DetailIsLoading = true;
    this.quoteLoading = true;
    const context = this.searchSubscription;
    let profileFailed = false;
    const active = () => context === this.searchSubscription;
    const acceptProfile = (profile: CompanyProfile) => {
      if (!active()) return;
      const alreadyOpen = this.searchResults?.ticker === ticker;
      this.searchError = '';
      this.lastSuccessfulSearch = ticker;
      this.recents.remember(ticker);
      const currency = typeof profile.currency === 'string' ? profile.currency.toUpperCase() : '';
      this.searchResults = { ...profile, currency: /^[A-Z]{3}$/.test(currency) ? currency : '', logo: this.httpsUrl(profile.logo) };
      if (alreadyOpen) return;
      this.loadSummary(ticker);
      this.loadActiveView();
      this.checkWatchlistStatus();
      this.refreshHolding(ticker);
    };
    const acceptQuoteOnly = () => {
      if (!this.currentStock || !profileFailed || this.searchResults || !active()) return false;
      // A valid quote can support research even when optional reference data is unavailable.
      // Currency remains unknown so trading stays disabled until verified by a profile.
      acceptProfile({ ticker, name: ticker, country: '', currency: '', exchange: '', ipo: '',
        logo: '', phone: '', weburl: '', finnhubIndustry: '' });
      return true;
    };
    const profileFailure = (message: string) => {
      if (!active()) return;
      profileFailed = true;
      if (this.searchResults || acceptQuoteOnly()) return;
      const input = this.tickerFormControl.value;
      if (typeof input === 'string' && input.trim().toUpperCase() === ticker) this.searchError = message;
    };
    context.add(this.getStockDetails(ticker).pipe(
      retry({ count: 1, delay: (error: HttpErrorResponse) => {
        const until = retryAfterTime(error.headers?.get('Retry-After') ?? null, Date.now());
        if (![429, 503].includes(error.status) || !until) throw error;
        this.DetailIsLoading = false;
        profileFailure('The security directory is busy. The lookup will retry after the provider cooldown.');
        return timer(Math.max(0, until - Date.now()));
      } }),
      finalize(() => { if (active()) this.DetailIsLoading = false; }),
    ).subscribe({
      next: profile => {
        if (!profile?.ticker) profileFailure(`No supported stock or ETF was found for ${ticker}. Check the symbol and try again.`);
        else acceptProfile(profile);
      },
      error: (error: HttpErrorResponse) => profileFailure(error.status === 404
        ? `No supported stock or ETF was found for ${ticker}. Check the symbol and try again.`
        : 'Security information is temporarily unavailable. Please try again.'),
    }));
    context.add(this.getLatestQuote(ticker, true).pipe(
      finalize(() => { if (active()) this.quoteLoading = false; }),
    ).subscribe(({ quote, previous }) => {
      if (!active()) return;
      this.currentStock = quote;
      this.quoteRefreshFailed = previous;
      acceptQuoteOnly();
    }));
  }

  private loadSummary(ticker: string): void {
    this.searchSubscription.add(this.getCompanyPeers(ticker).subscribe({
      next: peers => {
        const profileTicker = this.searchResults?.ticker;
        const current = typeof profileTicker === 'string' ? profileTicker.trim().toUpperCase() : ticker;
        this.companyPeers = Array.isArray(peers) ? [...new Set(peers
          .filter(peer => typeof peer === 'string')
          .map(peer => peer.trim().toUpperCase())
          .filter(peer => peer !== ticker && peer !== current && tickerPattern.test(peer)))] : [];
      },
      error: () => this.companyPeers = [],
    }));
  }

  private loadHourly(ticker: string, refresh = false): void {
    if (this.quoteLoading || this.hourlyLoading || this.priceRetrySeconds('hourly')
      || (this.hourlyBars && !refresh)) return;
    this.hourlyLoading = true;
    this.hourlyFailed = false;
    this.searchSubscription.add(this.getHistoricalData(ticker, this.currentStock).pipe(
      finalize(() => this.hourlyLoading = false),
    ).subscribe({
      next: hourly => {
        if (!hourly.length && this.hourlyBars?.length) {
          this.hourlyFailed = true;
          return;
        }
        this.priceRetryAt.hourly = 0;
        this.hourlyBars = hourly;
        if (this.overviewRange === 'Hourly') this.renderOverview();
      },
      error: (error: HttpErrorResponse) => {
        this.hourlyFailed = true;
        this.recordPriceFailure('hourly', error);
      },
    }));
  }

  loadOverview(refresh = false): void {
    const ticker = this.lastSuccessfulSearch;
    if (!ticker) return;
    if (this.overviewRange === 'Hourly') {
      this.loadHourly(ticker, refresh);
      return;
    }
    this.loadBenchmark(refresh);
    if (this.overviewDailyLoading || this.priceRetrySeconds('daily') || (this.overviewDailyBars && !refresh)) return;
    this.overviewDailyFailed = false;
    this.overviewDailyLoading = true;
    this.searchSubscription.add(this.getBigChartData(ticker, refresh).pipe(
      finalize(() => this.overviewDailyLoading = false),
    ).subscribe({
      next: ({ results }) => {
        if (!results.length && this.overviewDailyBars?.length) {
          this.overviewDailyFailed = true;
          return;
        }
        this.priceRetryAt.daily = 0;
        this.overviewDailyBars = results;
        if (this.overviewRange !== 'Hourly') this.renderOverview();
      },
      error: (error: HttpErrorResponse) => {
        this.overviewDailyFailed = true;
        this.recordPriceFailure('daily', error);
      },
    }));
  }

  get canCompare(): boolean {
    return this.searchResults?.currency === 'USD';
  }

  toggleBenchmark(): void {
    if (!this.canCompare || this.lastSuccessfulSearch === 'SPY' || this.searchResults?.ticker === 'SPY') return;
    this.selectComparison(this.comparisonTicker === 'SPY' ? null : 'SPY');
  }

  toggleComparisonPicker(input: HTMLInputElement): void {
    this.comparisonPickerOpen = !this.comparisonPickerOpen;
    this.comparisonInputError = '';
    if (!this.comparisonPickerOpen) return;
    input.value = this.comparisonTicker ?? '';
    requestAnimationFrame(() => {
      if (this.comparisonPickerOpen && input.isConnected) input.focus();
    });
  }

  closeComparisonPicker(trigger: HTMLButtonElement): void {
    this.comparisonPickerOpen = false;
    this.comparisonInputError = '';
    trigger.focus();
  }

  submitComparison(input: HTMLInputElement, trigger: HTMLButtonElement): void {
    const symbol = input.value.trim().toUpperCase();
    if (!tickerPattern.test(symbol) || symbol === this.lastSuccessfulSearch || symbol === this.searchResults?.ticker) {
      this.comparisonInputError = 'Enter a different stock or ETF ticker, such as MSFT.';
      input.focus();
      return;
    }
    this.selectComparison(symbol);
    this.closeComparisonPicker(trigger);
  }

  selectComparison(symbol: string | null): void {
    if (symbol && !this.canCompare) return;
    this.setComparison(symbol);
    if (symbol && this.overviewRange === 'Hourly') this.overviewRange = '1M';
    this.renderOverview();
    this.loadOverview();
    this.updateViewQuery();
  }

  private setComparison(symbol: string | null): void {
    if (this.comparisonTicker === symbol) return;
    this.benchmarkRequest?.unsubscribe();
    this.benchmarkRequest = undefined;
    this.comparisonTicker = symbol;
    this.benchmarkBars = null;
    this.benchmarkLoading = false;
    this.benchmarkFailed = false;
    this.priceRetryAt.benchmark = 0;
    this.benchmarkUnavailable = '';
  }

  loadBenchmark(refresh = false): void {
    const symbol = this.comparisonTicker;
    if (!symbol || this.benchmarkLoading || this.priceRetrySeconds('benchmark') || (this.benchmarkBars && !refresh) || this.benchmarkUnavailable
      || !this.lastSuccessfulSearch || this.overviewRange === 'Hourly') return;
    if (!this.canCompare || symbol === this.searchResults?.ticker) {
      this.benchmarkUnavailable = 'Comparison requires two different securities quoted in USD.';
      return;
    }

    this.benchmarkFailed = false;
    this.benchmarkLoading = true;
    const eligibility = symbol === 'SPY' ? of(true) : this.getStockDetails(symbol).pipe(
      map(profile => typeof profile?.ticker === 'string' && profile.ticker.trim().toUpperCase() === symbol
        && typeof profile.currency === 'string' && profile.currency.trim().toUpperCase() === 'USD'),
    );
    this.benchmarkRequest = eligibility.pipe(
      switchMap(eligible => {
        if (eligible) return this.getBigChartData(symbol, refresh);
        this.benchmarkUnavailable = `No USD-quoted security was found for ${symbol}.`;
        return EMPTY;
      }),
      finalize(() => this.benchmarkLoading = false),
    ).subscribe({
      next: ({ results }) => {
        if (!results.length && this.benchmarkBars?.length) {
          this.benchmarkFailed = true;
          return;
        }
        this.priceRetryAt.benchmark = 0;
        this.benchmarkBars = results;
        this.renderOverview();
      },
      error: (error: HttpErrorResponse) => {
        if (error.status === 404) this.benchmarkUnavailable = `No daily prices were found for ${symbol}.`;
        else {
          this.benchmarkFailed = true;
          this.recordPriceFailure('benchmark', error);
        }
      },
    });
    this.searchSubscription.add(this.benchmarkRequest);
  }

  selectOverviewRange(range: OverviewRange): void {
    if (this.overviewRange === range) return;
    this.overviewRange = range;
    if (range === 'Hourly') this.setComparison(null);
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
    const chartRange = researchRanges.find(value => value.toLowerCase() === query.get('range')) ?? '1M';
    const requestedInterval = researchIntervals.find(value => value === query.get('interval')) ?? defaultInterval(chartRange);
    const chartInterval = intervalReason(chartRange, requestedInterval) ? defaultInterval(chartRange) : requestedInterval;
    if (this.researchSelection.range !== chartRange || this.researchSelection.interval !== chartInterval) this.researchSelection = { range: chartRange, interval: chartInterval };
    const tab = this.detailTabs.find(item => item.id === query.get('view'))?.id ?? 'summary';
    const range = overviewRanges.find(item => item.toLowerCase() === query.get('range')) ?? '1M';
    const history = historyRanges.find(item => item.toLowerCase() === query.get('history')) ?? '1M';
    const symbol = query.get('compare')?.trim().toUpperCase() ?? '';
    const comparison = ticker && range !== 'Hourly' && symbol !== ticker.toUpperCase() && tickerPattern.test(symbol)
      ? symbol : null;
    const viewChanged = tab !== this.activeTab || range !== this.overviewRange || comparison !== this.comparisonTicker;
    this.activeTab = tab;
    if (ticker && tickerPattern.test(ticker.trim().toUpperCase()) && tab !== 'news') this.loadChartRuntime();
    if (range !== this.overviewRange || comparison !== this.comparisonTicker) {
      this.overviewRange = range;
      this.setComparison(comparison);
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
        range: this.researchSelection.range.toLowerCase(),
        interval: this.researchSelection.interval,
        history: history === '1m' ? null : history,
        compare: this.comparisonTicker?.toLowerCase() ?? null,
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

  retryMissingInsights(): void {
    if (this.activeTab !== 'insights' || !this.failedInsights.size || this.loadingTabs.has('insights')) return;
    this.loadedTabs.delete('insights');
    this.loadActiveView();
  }

  private loadInsights(ticker: string): Observable<unknown> {
    const read = <T>(section: InsightSection, request: () => Observable<T>): Observable<T | null> => {
      if (this.loadedInsights.has(section)) return of(null);
      return request().pipe(
        tap(() => {
          this.loadedInsights.add(section);
          this.failedInsights.delete(section);
        }),
        catchError(() => {
          this.failedInsights.add(section);
          return of(null);
        }),
      );
    };
    return forkJoin({
      earnings: read('earnings', () => this.getEarnings(ticker)),
      sentiment: read('sentiment', () => this.getSentiments(ticker)),
      recommendations: read('recommendations', () => this.getRecommendations(ticker)),
    }).pipe(tap(({ earnings, sentiment, recommendations }) => {
      if (!this.insightsAvailable) throw new Error('Insights unavailable');
      if (earnings !== null) this.earnings = earnings;
      if (recommendations !== null) this.recommendations = recommendations;
      if (sentiment !== null) this.sentiments = sentiment;
      this.calculateSummary();
      if (this.earnings.length || this.recommendations.length) this.createInsightChart();
    }));
  }

  private loadActiveView(): void {
    const tabName = this.activeTab;
    if (this.lastSuccessfulSearch && tabName !== 'news') this.loadChartRuntime();
    if (tabName === 'summary' || tabName === 'charts') return;
    const ticker = this.lastSuccessfulSearch;
    if (!ticker || this.loadingTabs.has(tabName) || this.loadedTabs.has(tabName)) return;


    const retry = this.failedTabs.has(tabName);
    this.loadingTabs.add(tabName);
    this.failedTabs.delete(tabName);
    let request: Observable<unknown>;
    switch (tabName) {
      case 'news':
        request = this.getTopNews(ticker).pipe(tap(news => this.setNews(news)));
        break;
      case 'insights':
        request = this.loadInsights(ticker);
        break;
    }
    this.searchSubscription.add(request.pipe(
      finalize(() => this.loadingTabs.delete(tabName)),
    ).subscribe({
      next: () => this.loadedTabs.add(tabName),
      error: (error: HttpErrorResponse) => {
        this.failedTabs.add(tabName);

      },
    }));
  }

  private loadChartRuntime(): void {
    if (this.chartRuntimeRequested) return;
    this.chartRuntimeRequested = true;
    void import('./research-chart-runtime').then(
      ({ Highcharts: runtime }) => { if (!this.destroyed) this.chartRuntime = runtime; },
      () => { if (!this.destroyed) this.chartRuntimeUnavailable = true; },
    );
  }

  retryChartRuntime(): void {
    // A reload lets the browser retry a module URL after a network failure.
    this.host.nativeElement.ownerDocument.defaultView?.location.reload();
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

  getLatestQuote(ticker: string, refresh = false): Observable<QuoteSnapshot> {
    return this.marketQuotes.read(ticker, refresh);
  }

  retryLatestQuote(): void {
    const ticker = this.lastSuccessfulSearch;
    if (!ticker || this.quoteLoading) return;
    const context = this.searchSubscription;
    this.quoteLoading = true;
    context.add(this.getLatestQuote(ticker, true).pipe(
      finalize(() => { if (context === this.searchSubscription) this.quoteLoading = false; }),
    ).subscribe(({ quote, previous }) => {
      if (context !== this.searchSubscription) return;
      this.currentStock = quote;
      this.quoteRefreshFailed = previous || !quote;
    }));
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
    return (stock.dp ?? 0) > 0 ? '#2254dc' : (stock.dp ?? 0) < 0 ? '#b4233c' : '#293950';
  }

  formatChangeValue(quote: QuoteResponse | null): string {
    if (quote?.d == null || !Number.isFinite(quote.d)) return '—';
    return `${quote.d >= 0 ? '+' : ''}${quote.d.toFixed(2)}`;
  }

  formatChangePercent(quote: QuoteResponse | null): string {
    if (quote?.dp == null || !Number.isFinite(quote.dp)) return '—';
    return `${quote.dp.toFixed(2)}%`;
  }

}
