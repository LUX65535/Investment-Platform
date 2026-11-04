import { Component, DestroyRef, inject, OnDestroy, OnInit, TemplateRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {Observable, of, Subscription, interval, forkJoin, shareReplay} from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, finalize, map, switchMap } from 'rxjs/operators';
import {Router} from '@angular/router';
import {FormControl} from "@angular/forms";
import * as Highcharts from 'highcharts/highstock';
import HC_exporting from 'highcharts/modules/exporting';
HC_exporting(Highcharts);
import { ActivatedRoute } from '@angular/router';
import {format, subDays} from "date-fns";
import StockModule from 'highcharts/modules/stock';
StockModule(Highcharts);
import volumeByPrice from 'highcharts/indicators/volume-by-price';
import indicators from 'highcharts/indicators/indicators';
indicators(Highcharts);
volumeByPrice(Highcharts);
import { PortfolioService  } from '../../services/portfolio.service';

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
export interface AggregateBarResponse {
  c: number;
  h: number;
  l: number;
  n: number;
  o: number;
  t: number;
  v: number;
  vw: number;
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
  actual: number;
  estimate: number;
  period: string;
  symbol: string;
  surprise: number;
}

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
  searchError = '';
  suggestionsError = false;
  watchlistPending = false;
  readonly exampleTickers = ['AAPL', 'MSFT', 'NVDA', 'AMZN'];
  private readonly destroyRef = inject(DestroyRef);
  private searchSubscription?: Subscription;
  activeTab: string = 'summary';
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
  selectedNewsItem: TopNews | null = null;

  bigChartOptions: Highcharts.Options = {};

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
  walletLoading = false;
  userWalletBalance = 0;
  ownedStockQuantity = 0;
  private tradeModal?: NgbModalRef;
  private newsModal?: NgbModalRef;

  constructor(
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private portfolioService: PortfolioService,
    private modal: NgbModal
  ) {}

  ngOnInit(): void {
    this.setupSearch();
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const ticker = params.get('ticker');
      if (ticker) {
        this.loadSearch(ticker);
      } else {
        this.resetSearch();
        this.tickerFormControl.setValue('');
      }
    });
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
    this.portfolioService.checkStock(ticker).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: position => {
        if (ticker === this.lastSuccessfulSearch) this.ownedStockQuantity = position.quantity;
      },
      error: () => {
        if (ticker === this.lastSuccessfulSearch) this.ownedStockQuantity = 0;
      }
    });
  }

  openTrade(template: TemplateRef<unknown>, side: 'buy' | 'sell'): void {
    if (!this.currentStock || this.tradeModal) return;
    this.tradeSide = side;
    this.tradeQuantity = 1;
    this.tradeError = '';
    this.userWalletBalance = 0;
    this.walletLoading = side === 'buy';
    this.tradeModal = this.modal.open(template, {
      ariaLabelledBy: 'trade-dialog-title',
      centered: true,
      beforeDismiss: () => !this.tradePending
    });
    this.tradeModal.result.then(() => this.tradeModal = undefined, () => this.tradeModal = undefined);

    if (this.walletLoading) {
      this.portfolioService.getBalance().pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.walletLoading = false)
      ).subscribe({
        next: ({ balance }) => this.userWalletBalance = balance,
        error: () => this.tradeError = 'Could not load your balance. Close this dialog and try again.'
      });
    }
  }

  get estimatedTradeTotal(): number {
    return (this.tradeQuantity ?? 0) * (this.currentStock?.c ?? 0);
  }

  get canSubmitTrade(): boolean {
    const quantity = this.tradeQuantity ?? 0;
    const price = this.currentStock?.c ?? 0;
    return !this.tradePending && !this.walletLoading && price > 0
      && Number.isSafeInteger(quantity) && quantity > 0
      && (this.tradeSide === 'buy' ? this.estimatedTradeTotal <= this.userWalletBalance : quantity <= this.ownedStockQuantity);
  }

  submitTrade(): void {
    const ticker = this.lastSuccessfulSearch;
    const price = this.currentStock?.c;
    const quantity = this.tradeQuantity;
    if (!this.canSubmitTrade || !ticker || !price || !quantity) return;

    const side = this.tradeSide;
    this.tradePending = true;
    this.tradeError = '';
    const trade = side === 'buy'
      ? this.portfolioService.buyStock(ticker, quantity, price)
      : this.portfolioService.sellStock(ticker, quantity, price);
    trade.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.tradePending = false)
    ).subscribe({
      next: () => {
        this.tradeModal?.close();
        this.refreshHolding(ticker);
        this.showConfirmationMessage(`${side === 'buy' ? 'Bought' : 'Sold'} ${quantity} ${ticker} ${quantity === 1 ? 'share' : 'shares'}.`);
      },
      error: (error: HttpErrorResponse) => {
        this.tradeError = typeof error.error?.message === 'string'
          ? error.error.message
          : 'The order did not go through. Please try again.';
      }
    });
  }

  createInsightChart(): void {
    const earningsData = this.earnings;
    const earningPeriods = earningsData.map(earn => earn.period);
    const actualData = earningsData.map(earn => earn.actual);
    const estimateData = earningsData.map(earn => earn.estimate);
    this.earningChartOptions = {
      chart: {
        backgroundColor: '#f8f9fa',
        type: 'spline'
      },
      title: {
        text: `Historical EPS Surprises`
      },

      xAxis: {
        categories: earningPeriods,
        labels: {
          align: 'center',
          formatter: function () {
            const earning = earningsData.find(earn => earn.period === this.value);
            return `${this.value}<br/>Surprise: ${earning ? earning.surprise : 'N/A'}`;
          },
          useHTML: true
        }
      },
      legend: {
        enabled: true
      },

      yAxis: {
        title: {
          text: 'Quarterly EPS'
        }
      },
      exporting: {
        enabled: false,
      },
      series: [{
        type: 'spline',
        name: 'Actual',
        data: actualData,
        color: '#7cb5ec'
      }, {
        type: 'spline',
        name: 'Estimate',
        data: estimateData,
        color: '#434348'
      }]
    };


    // Below left chart
    const colors = {
      'Strong Buy': '#186f37',
      'Buy': '#1fba55',
      'Hold': '#ba8b1d',
      'Sell': '#f45b5d',
      'Strong Sell': '#702f30'
    };
    const trendCategories = this.recommendations.map(trend => trend.period);
    interface CategoryData {
      'Strong Buy': number[];
      'Buy': number[];
      'Hold': number[];
      'Sell': number[];
      'Strong Sell': number[];
    }
    const categoryData: CategoryData = {
      'Strong Buy': [],
      'Buy': [],
      'Hold': [],
      'Sell': [],
      'Strong Sell': []
    };

    this.recommendations.forEach(trend => {
      categoryData['Strong Buy'].push(trend.strongBuy);
      categoryData['Buy'].push(trend.buy);
      categoryData['Hold'].push(trend.hold);
      categoryData['Sell'].push(trend.sell);
      categoryData['Strong Sell'].push(trend.strongSell);
    });
    const series = Object.entries(categoryData).map(([categoryName, data]) => {
      return {
        name: categoryName,
        data: data,
        color: colors[categoryName as keyof typeof colors]
      };
    });

    this.trendChartOptions = {
      chart: {
        backgroundColor: '#f8f9fa',
        type: 'column'
      },
      rangeSelector: {
        selected: 1
      },
      title: {
        text: `Recommendation Trends`
      },
      xAxis: {
        categories: trendCategories
      },
      legend: {
        enabled: true
      },

      yAxis: {
        min: 0,
        title: {
          text: '#Analysis'
        },

      },
      plotOptions: {
        column: {
          stacking: 'normal',
          dataLabels: {
            enabled: true
          }
        }
      },
      exporting: {
        enabled: false,
      },
      series: series as Highcharts.SeriesOptionsType[],
    };
  }


  getTopNews(ticker: string): Observable<TopNews[]> {
    const url = `/company_news?symbol=${ticker}`;
    return this.http.get<TopNews[]>(url);
  }
  openNews(template: TemplateRef<unknown>, newsItem: TopNews): void {
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
    const url = `/company_Earning?symbol=${ticker}`;
    return this.http.get<Earning[]>(url).pipe(
      map(earningsArray =>
        earningsArray.map(earning => ({
          actual: earning.actual === null ? 0 : earning.actual,
          estimate: earning.estimate === null ? 0 : earning.estimate,
          period: earning.period,
          symbol: earning.symbol,
          surprise: earning.surprise,
        }))
      )
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
    return this.http.get<{ results: AggregateBarResponse[] }>(`/company_data?symbol=${ticker}`);
  }
  createBigChart(data: { results: AggregateBarResponse[] }, ticker: string): Highcharts.Options {
    const ohlc = data.results.map(bar => [
      bar.t,
      bar.o,
      bar.h,
      bar.l,
      bar.c
    ]);

    const volume = data.results.map(bar => [bar.t, bar.v]);

    const chartOptions: Highcharts.Options = {
      rangeSelector: {
        buttons: [{
          type: 'month',
          count: 1,
          text: '1m'
        },{
          type: 'month',
          count: 3,
          text: '3m'
        },{
          type: 'month',
          count: 6,
          text: '6m'
        },{
          type: 'ytd',
          text: 'YTD',
        }, {
          type: 'year',
          count: 1,
          text: '1y'
        },
          {
            type: 'all',
            text: 'All'
          }],
        selected: 5,
        inputEnabled: true,
        enabled: true
      },
      title: {
        text: `${ticker} Historical`
      },
      subtitle: {
        text: 'With SMA and Volume by Price technical indicators'
      },
      legend: {
        enabled: false
      },
      xAxis: {
        type: 'datetime',
        dateTimeLabelFormats: {
          month: '%b \'%y',
          day: '%e %b',
        }
      },
      yAxis: [{
        startOnTick: false,
        endOnTick: false,
        labels: {
          align: 'right',
          x: -3
        },
        title: {
          text: 'OHLC'
        },
        height: '60%',
        lineWidth: 2,
        resize: {
          enabled: true
        }
      }, {
        labels: {
          align: 'right',
          x: -3
        },
        title: {
          text: 'Volume'
        },
        top: '65%',
        height: '35%',
        offset: 0,
        lineWidth: 2
      }],

      tooltip: {
        split: true,
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
        data: ohlc
      }, {
        type: 'column',
        name: 'Volume',
        id: 'volume',
        data: volume,
        yAxis: 1
      }, {
        type: 'vbp',
        linkedTo: 'aapl',
        params: {
          volumeSeriesID: 'volume'
        },
        dataLabels: {
          enabled: false
        },
        zoneLines: {
          enabled: false
        }
      }, {
        type: 'sma',
        linkedTo: 'aapl',
        zIndex: 1,
        marker: {
          enabled: false
        }
      }],
      navigator: {
        enabled: true,
        series: {
          color: 'blue',
          fillColor: {
            linearGradient: {
              x1: 0, y1: 0, x2: 0, y2: 1
            },
            stops: [
              [0, 'rgba(124, 181, 236, 1)'],
              [1, 'rgba(124, 181, 236, 0.1)']
            ]
          },
        },
      },
    };
    return chartOptions;
  }

  getHistoricalData(ticker: string, quote: QuoteResponse): Observable<AggregateBarResponse[]> {
    const latest = new Date(quote.t * 1000);
    const from = format(subDays(latest, 1), 'yyyy-MM-dd');
    const to = format(latest, 'yyyy-MM-dd');
    return this.http.get<{ results?: AggregateBarResponse[] }>('/company_OneDay_data', {
      params: { symbol: ticker, from, to }
    }).pipe(map(response => response.results ?? []));
  }

  createChart(data: AggregateBarResponse[]): void {
    const seriesData = data.map(point => [point.t, point.c]);

    const stockColor = this.currentStock ? this.getChangeColor(this.currentStock) : 'black';

    this.chartOptions = {
      rangeSelector: {
        selected: 1
      },
      title: {
        text: `${this.lastSuccessfulSearch} hourly price`
      },
      legend: {
        enabled: false
      },
      plotOptions: {
        series: {
          marker: {
            enabled: false
          }
        }
      },
      xAxis: {
        type: 'datetime',
        dateTimeLabelFormats: {
          hour: '%H:%M',
        }
      },
      yAxis: {
        title: {
          text: null
        }
      },
      chart: {
        backgroundColor: '#F5F5F5',
      },
      exporting: {
        enabled: false,
      },
      series: [{
        name: `${this.lastSuccessfulSearch}`,
        data: seriesData,
        type: 'spline',
        color: stockColor,
        tooltip: {
          valueDecimals: 2
        }
      }]
    };
  }

  ngOnDestroy(): void {
    this.searchSubscription?.unsubscribe();
    this.tradeModal?.close();
    this.newsModal?.close();
    clearTimeout(this.confirmationTimeout);
  }

  setupAutoUpdate(): void {
    interval(30000).pipe(
      switchMap(() => {
        const ticker = this.lastSuccessfulSearch;
        if (!ticker || document.hidden) return of(null);
        return this.getLatestQuote(ticker).pipe(
          map(quote => ({ ticker, quote })),
          catchError(() => of(null))
        );
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(update => {
      if (update && update.quote.c > 0 && update.ticker === this.lastSuccessfulSearch) {
        this.currentStock = update.quote;
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
    } else {
      void this.router.navigate(['/search-details', ticker]);
    }
  }

  private resetSearch(): void {
    this.searchSubscription?.unsubscribe();
    this.lastSuccessfulSearch = null;
    this.DetailIsLoading = false;
    this.searchError = '';
    this.searchResults = null;
    this.currentStock = null;
    this.isFavorited = false;
    this.ownedStockQuantity = 0;
    this.activeTab = 'summary';
    this.tradeModal?.close();
    this.newsModal?.close();
    this.selectedNewsItem = null;
    this.chartOptions = {};
    this.bigChartOptions = {};
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
    const quote$ = this.getLatestQuote(ticker).pipe(
      catchError(() => of(null)),
      shareReplay({ bufferSize: 1, refCount: true })
    );
    this.searchSubscription = forkJoin({
      profile: this.getStockDetails(ticker),
      quote: quote$,
      peers: this.getCompanyPeers(ticker).pipe(catchError(() => of([]))),
      hourly: quote$.pipe(
        switchMap(quote => quote && quote.t > 0 ? this.getHistoricalData(ticker, quote) : of([])),
        catchError(() => of([]))
      ),
      daily: this.getBigChartData(ticker).pipe(catchError(() => of(null))),
      news: this.getTopNews(ticker).pipe(catchError(() => of([]))),
      earnings: this.getEarnings(ticker).pipe(catchError(() => of([]))),
      sentiment: this.getSentiments(ticker).pipe(catchError(() => of(null))),
      recommendations: this.getRecommendations(ticker).pipe(catchError(() => of([])))
    }).pipe(finalize(() => this.DetailIsLoading = false)).subscribe({
      next: ({ profile, quote, peers, hourly, daily, news, earnings, sentiment, recommendations }) => {
        if (!profile?.ticker) {
          this.searchError = `No company found for ${ticker}. Try another ticker.`;
          return;
        }

        this.lastSuccessfulSearch = ticker;
        this.searchResults = profile;
        this.currentStock = quote && quote.c > 0 ? quote : null;
        this.companyPeers = peers;
        this.topNews = news.filter(article => article.image).slice(0, 20);
        this.earnings = earnings;
        this.recommendations = recommendations;
        this.sentiments = sentiment;
        this.calculateSummary();
        if (earnings.length || recommendations.length) this.createInsightChart();
        if (hourly.length) this.createChart(hourly);
        if (daily?.results?.length) this.bigChartOptions = this.createBigChart(daily, ticker);
        this.checkIfFavorited(ticker);
        this.refreshHolding(ticker);
      },
      error: (error: HttpErrorResponse) => {
        this.searchError = error.status === 404
          ? `No company found for ${ticker}. Try another ticker.`
          : 'Company data is temporarily unavailable. Please try again.';
      }
    });
  }

  setActiveTab(tabName: string): void {
    this.activeTab = tabName;
  }

  clearSearch(): void {
    this.resetSearch();
    this.tickerFormControl.setValue('');
    void this.router.navigate(['/search-details']);
  }

  private checkIfFavorited(ticker: string): void {
    this.http.get<boolean>(`/api/watchlist/check/${encodeURIComponent(ticker)}`).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: favorited => {
        if (ticker === this.lastSuccessfulSearch) this.isFavorited = favorited;
      },
      error: () => {}
    });
  }

  getLatestQuote(ticker: string): Observable<QuoteResponse> {
    return this.http.get<QuoteResponse>('/company_quote', { params: { symbol: ticker } });
  }

  getCompanyPeers(ticker: string): Observable<string[]> {
    const url = `/company_peers?symbol=${ticker}`;
    return this.http.get<string[]>(url);
  }


  toggleFavorite(): void {
    const ticker = this.lastSuccessfulSearch;
    if (!ticker || this.watchlistPending) return;

    const adding = !this.isFavorited;
    this.watchlistPending = true;
    const request = adding
      ? this.http.post('/api/watchlist', { ticker })
      : this.http.delete(`/api/watchlist/${encodeURIComponent(ticker)}`);
    request.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.watchlistPending = false)
    ).subscribe({
      next: () => {
        if (ticker === this.lastSuccessfulSearch) {
          this.isFavorited = adding;
          this.showConfirmationMessage(adding ? `${ticker} added to your watchlist.` : `${ticker} removed from your watchlist.`);
        }
      },
      error: () => this.showConfirmationMessage('Could not update your watchlist. Please try again.', true)
    });
  }

  closeConfirmation(): void {
    this.showConfirmation = false;
  }

  displayFn(selection: StockResult | string): string {
    return typeof selection === 'string' ? selection : selection?.displaySymbol ?? '';
  }

  getChangeColor(stock: QuoteResponse): string {
    return stock.dp > 0 ? '#08734b' : stock.dp < 0 ? '#b4233c' : '#293950';
  }

  formatChangeValue(quote: QuoteResponse | null): string {
    if (!quote || quote.d === undefined) return '0.00';
    return `${quote.d >= 0 ? '+' : ''}${quote.d.toFixed(2)}`;
  }

  formatChangePercent(quote: QuoteResponse | null): string {
    if (!quote || quote.dp === undefined) return '0.00';
    return `${quote.dp.toFixed(2)}%`;
  }

}
