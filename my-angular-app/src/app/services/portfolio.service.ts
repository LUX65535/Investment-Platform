import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {map} from "rxjs/operators";
export interface Stock {
  ticker: string;
  name: string;
  price: number;
  change: number;
  quantity: number;
  totalCost: number;
}
@Injectable({
  providedIn: 'root'
})
export class PortfolioService {

  constructor(private http: HttpClient) { }

  getStocks(): Observable<Stock[]> {
    return this.http.get<Stock[]>('/api/stocks').pipe(
      map((stocksFromApi) => {
        return stocksFromApi.map((stockFromApi) => {
          return {
            ticker: stockFromApi.ticker,
            name: '',
            price: 0,
            change: 0,
            quantity: stockFromApi.quantity,
            totalCost: stockFromApi.totalCost
          };
        });
      })
    );
  }
  getBalance(): Observable<{ balance: number }> {
    return this.http.get<{ balance: number }>('/api/balance');
  }
  initializeWallet(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>('/api/initWallet', {});
  }
  checkStock(ticker: string): Observable<any> {
    return this.http.get(`/api/stocks/${ticker}`);
  }

  buyStock(ticker: string, quantity: number, buyPrice: number): Observable<Object> {
    return this.http.post('/api/buy', { ticker, quantity, buyPrice });
  }

  sellStock(ticker: string, quantity: number, sellPrice: number): Observable<Object> {
    return this.http.post('/api/sell', { ticker, quantity, sellPrice });
  }

}
