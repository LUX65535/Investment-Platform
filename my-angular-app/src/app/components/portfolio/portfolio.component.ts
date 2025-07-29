import {ChangeDetectorRef, Component, OnInit} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PortfolioService } from '../../services/portfolio.service';
import { Router } from '@angular/router';
import {forkJoin, Observable} from "rxjs";
import {CompanyProfile, QuoteResponse} from "../search-details/search-details.component";
import {tap} from "rxjs/operators";

export interface Stock {
  ticker: string;
  name: string;
  price: number;
  change: number;
  quantity: number;
  totalCost: number;
}


@Component({
  selector: 'app-portfolio',
  templateUrl: './portfolio.component.html',
  styleUrls: ['./portfolio.component.css']
})
export class PortfolioComponent implements OnInit {

  showBuyModal: boolean = false;
  quantity: number = 0 ;
  userWalletBalance: number = 0;

  showSellModal: boolean = false;
  quantityToSell: number = 0;
  ownedStockQuantity: number = 0;

  currentStock: QuoteResponse | null = null;
  searchResults: CompanyProfile | null = null;


  showConfirmation: boolean = false;
  confirmationMessage: string = '';
  confirmationStyle: string = '';

  portfolio: Stock[] = [];
  cashBalance: number = 0;
  isLoading: boolean = true;
  constructor(private portfolioService: PortfolioService,private http: HttpClient,private cdr: ChangeDetectorRef,private router: Router) {}

  ngOnInit(): void {
    this.loadPortfolio();
    this.loadBalance();
  }
  onInitializeWallet(): void {
    this.portfolioService.initializeWallet().subscribe({
      next: (response) => console.log(response.message),
      error: (error) => console.error('Error initializing wallet:', error)
    });
    this.loadBalance();
    this.cdr.detectChanges();
    this.router.navigateByUrl(`/portfolio`);
    this.refreshComponent()
  }
  loadPortfolio(): void {
    this.portfolioService.getStocks().subscribe({
      next: (stocks) => {
        this.portfolio = stocks;
        this.isLoading = false;
        this.updatePortfolioPricesAndChanges();
      },
      error: (error) => {
        console.error('Error loading portfolio:', error);
        this.isLoading = false;
      }
    });
  }

  refreshComponent(): void {
    this.loadPortfolio();
    this.loadBalance();
    this.updatePortfolioPricesAndChanges();
    const currentUrl = this.router.url;
    this.router.navigateByUrl('/', { skipLocationChange: true }).then(() => {
      this.router.navigate([currentUrl]);
    });
  }

  updatePortfolioPricesAndChanges(): void {
    const quoteRequests = this.portfolio.map(stock => this.getLatestQuote(stock.ticker));
    forkJoin(quoteRequests).subscribe(quotes => {
      quotes.forEach((quote, index) => {
        this.portfolio[index].price = quote.c;
        this.portfolio[index].change = quote.d;
      });
    });
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

  loadBalance(): void {
    this.portfolioService.getBalance().subscribe({
      next: (data) => {
        this.cashBalance = data.balance;
        this.isLoading = false;

      },
      error: (error) => {
        console.error('Error fetching balance:', error);
        this.isLoading = false;

      }
    });
  }
  private showErrorMessage(message: string): void {
  this.confirmationMessage = message;
  this.confirmationStyle = 'alert-danger';
  this.showConfirmation = true;
  setTimeout(() => this.showConfirmation = false, 3000);
}
  buyStockForm(quantity: number) {
    if (!this.searchResults){
      console.error('No ticker bug');
      return
    }
    if (!this.currentStock) {
      console.error('No stock data available');
      return;
    }
    if(quantity * this.currentStock.c > this.userWalletBalance) {
      console.log('Not Enough Money');
      return;
    }
    console.log(`Bought ${quantity} share ${this.searchResults?.ticker}`);
    this.buyStock(this.searchResults?.ticker,quantity,this.currentStock.c);
    this.buyOrSell(true);
    this.showBuyModal = false;
  }


  buyStock(ticker: string, quantity: number, buyPrice: number): void {
    this.portfolioService.buyStock(ticker, quantity, buyPrice).subscribe({
      next: (response) => {
        console.log('Stock purchased successfully', response);
        this.loadPortfolio();
        this.loadBalance();
      },
      error: (error) => console.error('Error buying stock:', error)
    });
  }
  getStockDetails(ticker: string): Observable<CompanyProfile> {
    const url = `/company_profile?symbol=${ticker}`;
    return this.http.get<CompanyProfile>(url);
  }

    sellStockForm(quantityToSell: number): void {
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
    this.sellStock(this.searchResults?.ticker,quantityToSell,this.currentStock.c);
    this.buyOrSell(false);
    this.showSellModal = false;
  }

  sellStock(ticker: string, quantity: number, sellPrice: number): void {
    this.portfolioService.sellStock(ticker, quantity, sellPrice).subscribe({
      next: (response) => {
        console.log('Stock Sold successfully', response);
        this.loadPortfolio();
        this.loadBalance();
      },
      error: (error) => console.error('Error buying stock:', error)
    });
  }
  openBuyModal(ticker: string) {
    this.getBalance();

    forkJoin({
      latestQuote: this.getLatestQuote(ticker),
      stockDetails: this.getStockDetails(ticker)
    }).subscribe({
      next: ({ latestQuote, stockDetails }) => {
        this.currentStock = latestQuote;
        this.searchResults = stockDetails;
        this.showBuyModal = true;
      },
      error: (error) => {
        console.error('Error fetching stock data:', error);
      }
    });
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

  openSellModal(ticker: string, quantity: number): void {
    forkJoin({
      latestQuote: this.getLatestQuote(ticker),
      stockDetails: this.getStockDetails(ticker),
    }).subscribe({
      next: ({ latestQuote, stockDetails }) => {
        this.currentStock = latestQuote;
        this.searchResults = stockDetails;
        this.ownedStockQuantity = quantity;
        this.showSellModal = true;
      },
      error: (error) => {
        console.error('Error fetching stock data:', error);
      }
    });
  }

  closeConfirmation(): void {
    this.showConfirmation = false;
  }
  getLatestQuote(ticker: string): Observable<QuoteResponse> {
    const url = `/company_quote?symbol=${ticker}`;
    return this.http.get<QuoteResponse>(url).pipe(
      tap(quote => {
        this.currentStock = quote;
      })
    );
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
}
