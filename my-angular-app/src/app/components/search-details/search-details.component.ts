import {Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {Observable, of, Subscription, interval, startWith, forkJoin} from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, finalize, map, switchMap, tap } from 'rxjs/operators';
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
  tickerFormControl = new FormControl();
  filteredOptions: Observable<StockResult[]> = of([]);
  isLoading = false;
  DetailIsLoading = false;
  noDataFound = false;
  invalid_ticker_input = false;
  activeTab: string = 'summary';
  searchResults: CompanyProfile | null = null;

  private updateSubscription: Subscription = new Subscription();
  marketIsOpen: boolean = false;
  private lastSuccessfulSearch: string | null = null;

  currentStock: QuoteResponse | null = null;
  companyPeers: string[] = [];

  Highcharts: typeof Highcharts = Highcharts;
  chartOptions: Highcharts.Options = {};
  trendChartOptions: Highcharts.Options = {};
  earningChartOptions: Highcharts.Options = {};

  lastClosedTime: number | null = null;
  currentDate = new Date();

  isFavorited: boolean = false;


  historicalData: AggregateBarResponse[] | null = null;
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


  showBuyModal: boolean = false;
  quantity: number = 0 ;
  userWalletBalance: number = 0;

  showSellModal: boolean = false;
  quantityToSell: number = 0;
  ownedStockQuantity: number = 0;


  currentTickerForSecure: string = '';
  constructor(private http: HttpClient,private route: ActivatedRoute,
              private router: Router, private portfolioService: PortfolioService) {}

  ngOnInit(): void {
    this.route.params.subscribe(params => {
      const ticker = params['ticker'];
      if (ticker) {
        this.currentTickerForSecure = ticker;
        this.onSearch(ticker);
      }
    });
    this.Highcharts.setOptions({
      global: {
        useUTC: false,
      },
      lang: {
        shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
          'Thursday', 'Friday', 'Saturday']
      }
    });
    this.setupAutoUpdate();
    this.setupSearch();
  }

  private showErrorMessage(message: string): void {
  this.confirmationMessage = message;
  this.confirmationStyle = 'alert-danger';
  this.showConfirmation = true;
  setTimeout(() => this.showConfirmation = false, 3000);
}

private updatePortfolioData(): void {
  this.getBalance();
  if (this.lastSuccessfulSearch) {
    this.getStockQuantity(this.lastSuccessfulSearch);
  }
}

  getStockQuantity(ticker:string): void{
    this.portfolioService.checkStock(ticker).subscribe(
      {
        next: (response) =>{
          this.ownedStockQuantity = response.quantity;
          return;
        }
      }
    )
  }
  openSellModal(): void {
    this.showSellModal = true;
  }

  sellStockForm(): void {
    if (!this.searchResults || !this.searchResults.ticker || !this.currentStock){
      this.showErrorMessage('No valid stock data available. Please search for a ticker first.');
      return
    }

    if (this.quantityToSell <= 0) {
      this.showErrorMessage('Quantity must be greater than zero.');
      return;
    }

    if (this.quantityToSell > this.ownedStockQuantity) {
      this.showErrorMessage('Not enough stocks owned.');
      return;
    }
    console.log(`Sold ${this.quantityToSell} share ${this.searchResults?.ticker}`);
    this.sellStock(this.searchResults?.ticker,this.quantityToSell,this.currentStock.c);
    this.buyOrSell(false);
    this.showSellModal = false;
  }


  openBuyModal() {
    this.getBalance();
    this.showBuyModal = true;
  }
  getBalance(): void{
    this.portfolioService.getBalance().subscribe(
      {
        next: (response) =>{
          this.userWalletBalance = response.balance;
          return;
        }
      }
    )
  }


buyStockForm() {
  if (!this.searchResults || !this.searchResults.ticker || !this.currentStock) {
    this.showErrorMessage('No valid stock data available. Please search for a ticker first.');
    return;
  }
  if (this.quantity <= 0) {
    this.showErrorMessage('Quantity must be greater than zero.');
    return;
  }
  if (this.quantity * this.currentStock.c > this.userWalletBalance) {
    this.showErrorMessage('Not enough money in wallet.');
    return;
  }
    console.log(`Bought ${this.quantity} share ${this.searchResults?.ticker}`);
    this.buyStock(this.searchResults?.ticker,this.quantity,this.currentStock.c);
    this.buyOrSell(true);
    this.showBuyModal = false;
  }


buyStock(ticker: string, quantity: number, buyPrice: number): void {
  this.portfolioService.buyStock(ticker, quantity, buyPrice).subscribe({
    next: (response) => {
      console.log('Stock purchased successfully', response);
      this.updatePortfolioData();
    },
    error: (error) => console.error('Error buying stock:', error)
  });
}
sellStock(ticker: string, quantity: number, sellPrice: number): void {
  this.portfolioService.sellStock(ticker, quantity, sellPrice).subscribe({
    next: (response) => {
      console.log('Stock sold successfully', response);
      this.updatePortfolioData();
    },
    error: (error) => console.error('Error selling stock:', error)
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
  openModal(newsItem: TopNews): void {
    this.selectedNewsItem = newsItem;
  }
  closeModal(): void {
    this.selectedNewsItem = null;
  }

  shareOnPlatform(newsItem: TopNews, platform: string): void {
    let url: string = '';
    if (platform === 'twitter') {
      url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(newsItem.headline)}&url=${encodeURIComponent(newsItem.url)}`;
    } else if (platform === 'facebook') {
      url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(newsItem.url)}`;
    }
    window.open(url, '_blank');
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

      this.calculatedSentiments = this.sentiments.data.reduce((accumulator, current) => {
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

  getHistoricalData(ticker: string): Observable<AggregateBarResponse[]> {
    return this.getLatestQuote(ticker).pipe(
      switchMap(quote => {
        let from_date = new Date();
        let to_date = new Date();

        if (this.marketIsOpen) {
          from_date = subDays(from_date, 1);
        } else {
          from_date = new Date(quote.t * 1000);
          from_date = subDays(from_date, 1);
          to_date = new Date(quote.t * 1000);
        }

        const from_date_str = format(from_date, 'yyyy-MM-dd');
        const to_date_str = format(to_date, 'yyyy-MM-dd');

        return this.http.get<{results: AggregateBarResponse[]}>(`/company_OneDay_data?symbol=${ticker}&from=${from_date_str}&to=${to_date_str}`)
          .pipe(
            map(response => {
              if (response && Array.isArray(response.results)) {
                return response.results;
              } else {
                throw new Error('Response does not contain array');
              }
            }),
            catchError(error => {
              console.error('Error fetching data: ', error);
              return of([]);
            })
          );
      })
    );
  }




  createChart(data: AggregateBarResponse[]): void {
    const etToPdt = (timestamp: number): number => {
      return timestamp - (3 * 3600000);
    };
    const seriesData = data.map(point => [etToPdt(point.t), point.c]);

    const stockColor = this.currentStock ? this.getChangeColor(this.currentStock) : 'black';

    this.chartOptions = {
      rangeSelector: {
        selected: 1
      },
      title: {
        text: `${this.lastSuccessfulSearch} Hourly Price Variation`
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
    if (this.updateSubscription) {
      this.updateSubscription.unsubscribe();
    }
  }
  setupAutoUpdate(): void {
    this.updateSubscription = interval(15000)
      .pipe(
        startWith(0),
        tap(() => {
          this.currentDate = new Date();
        }),
        switchMap(() => {
          if (!this.lastSuccessfulSearch || !this.marketIsOpen) {
          return of(null);
        }
          return this.getLatestQuote(this.lastSuccessfulSearch);
        })
      )
      .subscribe(
        quote  => {
          if (quote) {
            this.currentStock = quote;
            if (this.historicalData) {
              this.createChart(this.historicalData);
            }
            const marketStatus = this.isMarketOpen(quote.t);
            this.marketIsOpen = marketStatus.isOpen;
            this.lastClosedTime = marketStatus.lastClosed;
          }
        },
        error => console.error('Error updating data: ', error)
      );
  }

  setupSearch(): void {
    this.filteredOptions = this.tickerFormControl.valueChanges.pipe(
      debounceTime(1000),
      distinctUntilChanged(),
      tap(() => this.isLoading = true),
      switchMap(term => term === "" ? of([]) : this.getStocks(term).pipe(finalize(() => this.isLoading = false))),
      catchError(() => of([]))
    );
  }

  getStocks(term: string): Observable<StockResult[]> {
    return this.http.get<{result: StockResult[]}>(`/Autocomplete_Search?symbol=${term}`).pipe(
      map(response => response.result)
    );
  }

  getStockDetails(ticker: string): Observable<CompanyProfile> {
    const url = `/company_profile?symbol=${ticker}`;
    return this.http.get<CompanyProfile>(url);
  }

  onPeerClick(ticker: string): void {
    this.onSearch(ticker);
  }

  SearchButton(ticker?: string): void {
    const searchTerm = ticker ?? this.tickerFormControl.value;
    this.router.navigateByUrl(`/search-details/${searchTerm}`);
  }
  loadAndCreateChart(ticker: string): void {
    this.getBigChartData(ticker).subscribe({
      next: (data) => {
        if (data.results.length > 0) {
          this.bigChartOptions = this.createBigChart(data, ticker);
        } else {
          console.error('No data available for chart.');
        }
      },
      error: (error) => console.error('Error fetching chart data:', error)
    });
  }
  onSearch(selectedOption?: StockResult | string): void {
    this.DetailIsLoading = true;
    this.invalid_ticker_input = false;
    this.noDataFound = false;
    this.searchResults = null;
    this.currentStock = null;
    this.isLoading = true;

    const searchTerm = typeof selectedOption === 'string'
      ? selectedOption
      : selectedOption?.displaySymbol || this.tickerFormControl.value;
    if (this.tickerFormControl.value) {

    this.getStockQuantity(this.tickerFormControl.value);
    }else{
      this.getStockQuantity(this.currentTickerForSecure);
    }
    if (searchTerm) {
      this.loadAndCreateChart(searchTerm)
      forkJoin({
        profile: this.getStockDetails(searchTerm),
        quote: this.getLatestQuote(searchTerm),
        peer: this.getCompanyPeers(searchTerm),
        historicalData: this.getHistoricalData(searchTerm),
        news: this.getTopNews(searchTerm),
        earning: this.getEarnings(searchTerm),
        sentiment: this.getSentiments(searchTerm),
        trend: this.getRecommendations(searchTerm)
      }).subscribe(
        ({ profile, quote,peer, historicalData,news,earning,sentiment,trend  }) => {

          if (profile && Object.keys(profile).length > 0) {
            this.sentiments = sentiment;
            this.recommendations = trend;
            this.earnings = earning;
            this.calculateSummary();
            this.topNews = news
              .filter(n => n.image)
              .slice(0, 20);
            this.lastSuccessfulSearch = searchTerm;
            this.searchResults = profile;
            this.currentStock = quote;
            this.companyPeers = peer;
            this.checkIfFavorited();
            this.createInsightChart();
            this.historicalData = historicalData;
            this.createChart(this.historicalData);
          } else {
            console.error("No data found for ticker: ", searchTerm);
            this.noDataFound = true;
            this.DetailIsLoading = false;
          }
          this.DetailIsLoading = false;
          this.isLoading = false;
        },
        error => {
          console.error("Search failed for ticker: ", searchTerm, error);
          this.invalid_ticker_input = true;
          this.isLoading = false;
          this.DetailIsLoading = false;
        }
      );
    } else {
      console.error("Invalid search term.");
      this.invalid_ticker_input = true;
      this.isLoading = false;
      this.DetailIsLoading = false;
    }

  }
  setActiveTab(tabName: string) {
    this.activeTab = tabName;
  }
  clearSearch(): void {





    this.showBuyModal = false;
    this.quantity=0;
    this.userWalletBalance= 0;

    this.showSellModal = false;
    this.quantityToSell = 0;
    this.ownedStockQuantity = 0;

    this.lastSuccessfulSearch = null;
    this.tickerFormControl.setValue("");
    this.searchResults = null;
    this.invalid_ticker_input = false;
    this.noDataFound = false;
    if (this.updateSubscription) {
      this.updateSubscription.unsubscribe();
    }
    this.router.navigate(['/search-details']);
  }

  checkIfFavorited(): void {
    if (!this.lastSuccessfulSearch) return;

    this.http.get<boolean>(`/api/watchlist/check/${this.lastSuccessfulSearch}`).subscribe({
      next: (isFavorited: boolean) => {
        this.isFavorited = isFavorited;
      },
      error: (error) => {
        console.error('Error checking if in watchlist', error);
      }
    });
  }

  getLatestQuote(ticker: string): Observable<QuoteResponse> {
    const url = `/company_quote?symbol=${ticker}`;
    return this.http.get<QuoteResponse>(url).pipe(
      tap(quote => {
        const marketStatus = this.isMarketOpen(quote.t);
        this.marketIsOpen = marketStatus.isOpen;
        if (!marketStatus.isOpen && marketStatus.lastClosed !== null) {
          this.lastClosedTime = marketStatus.lastClosed;
          if (this.lastClosedTime) {
            this.lastClosedTime = new Date(this.lastClosedTime).setSeconds(new Date(this.lastClosedTime).getSeconds());
          }
        } else {
          this.lastClosedTime = null;
        }
      })
    );
  }
  getCompanyPeers(ticker: string): Observable<string[]> {
    const url = `/company_peers?symbol=${ticker}`;
    return this.http.get<string[]>(url);
  }


  addToWatchlist(): void {
    if (!this.lastSuccessfulSearch) return;
     this.http.post('/api/watchlist', { ticker: this.lastSuccessfulSearch }).subscribe({
        next: () => console.log('Added to watchlist', this.lastSuccessfulSearch),
        error: (error) => console.error('Error adding to watchlist', error)
      });
  }

  removeFromWatchlist(): void {
    if (!this.lastSuccessfulSearch) return;

    this.http.delete(`/api/watchlist/${this.lastSuccessfulSearch}`).subscribe({
      next: () => console.log('Removed from watchlist', this.lastSuccessfulSearch),
      error: (error) => console.error('Error removing from watchlist', error)
    });
  }

  toggleFavorite(): void {
    if (!this.lastSuccessfulSearch) return;

    this.isFavorited = !this.isFavorited;
    this.showConfirmation = true;
    const ticker = this.searchResults?.ticker;
    if (ticker) {
      if (this.isFavorited) {
        this.confirmationMessage = `${ticker} added to Watchlist.`;
        this.confirmationStyle = 'alert-success';
        this.addToWatchlist();
      } else {
        this.confirmationMessage = `${ticker} removed from Watchlist.`;
        this.confirmationStyle = 'alert-danger';
        this.removeFromWatchlist();
      }
      setTimeout(() => this.showConfirmation = false, 3000);
    }
  }
  buyOrSell(buyStock: boolean): void{
    this.showConfirmation = true;
    const ticker = this.searchResults?.ticker;
    if (ticker) {
      if (buyStock) {
        this.confirmationMessage = `${ticker} bought successfully`;
        this.confirmationStyle = 'alert-success';
      } else {
        this.confirmationMessage = `${ticker} sold successfully`;
        this.confirmationStyle = 'alert-danger';
      }
      setTimeout(() => this.showConfirmation = false, 3000);
    }
  }
  closeConfirmation(): void {
    this.showConfirmation = false;
  }
  displayFn(stockResult: StockResult): string {
    return stockResult && stockResult.displaySymbol ? stockResult.displaySymbol : '';
  }

  getChangeColor(stock: QuoteResponse): string {
    return stock.dp > 0 ? 'green' : stock.dp < 0 ? 'red' : 'black';
  }

  formatChangeValue(quote: QuoteResponse | null): string {
    if (!quote || quote.d === undefined) return '0.00';
    return `${quote.d >= 0 ? '+' : ''}${quote.d.toFixed(2)}`;
  }

  formatChangePercent(quote: QuoteResponse | null): string {
    if (!quote || quote.dp === undefined) return '0.00';
    return `${quote.dp.toFixed(2)}%`;
  }

  isMarketOpen(timestamp: number): { isOpen: boolean; lastClosed: number | null } {
    const currentTimestamp = Date.now();
    const isOpen = (currentTimestamp - timestamp * 1000) < 5 * 60 * 1000;
    const lastClosed = isOpen ? null : timestamp * 1000;
    return { isOpen, lastClosed };
  }
}
