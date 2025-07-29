import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {forkJoin, Observable, of} from 'rxjs';
import {catchError,mergeMap} from 'rxjs/operators';
import { ActivatedRoute, Router } from '@angular/router';


interface QuoteResponse {
  c: number;
  d: number;
  dp: number;
  o: number;
}
interface CompanyProfile {
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
interface WatchlistItem {
  ticker: string;
  quote?: QuoteResponse;
  profile?: CompanyProfile;
}

@Component({
  selector: 'app-watchlist',
  templateUrl: './watchlist.component.html',
  styleUrls: ['./watchlist.component.css'],
})
export class WatchlistComponent implements OnInit {
  public watchlist: WatchlistItem[] = [];
  public loading = true;

  constructor(private http: HttpClient,private route: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    this.loadWatchlist();
  }

  loadWatchlist(): void {
    this.loading = true;
    this.http.get<WatchlistItem[]>('/api/watchlist').pipe(
      mergeMap(watchlistItems => {
        if (watchlistItems.length === 0) {
          this.loading = false;
          return of([]);
        }
        return forkJoin(
          watchlistItems.map(item =>
            forkJoin({
              profile: this.getCompanyProfile(item.ticker),
              quote: this.getCompanyQuote(item.ticker)
            }).pipe(
              catchError(error => {
                console.error(`Error loading data for ticker ${item.ticker}: `, error);
                return of({ profile: undefined, quote: undefined });
              })
            )
          )
        );
      }),
      catchError(error => {
        console.error('Error loading watchlist: ', error);
        this.loading = false;
        return of([]);
      })
    ).subscribe((results: Array<{profile?: CompanyProfile, quote?: QuoteResponse}>) => {
      this.watchlist = [];
      results.forEach(result => {
        if (result.profile && result.quote) {
          this.watchlist.push({
            ticker: result.profile.ticker,
            profile: result.profile,
            quote: result.quote
          });
        }
      });
      this.loading = false;
    });
  }
  selectStock(ticker: string): void {
    this.router.navigateByUrl(`/search-details/${ticker}`);
  }
  getChangeColor(item: WatchlistItem): string {
    if (item.quote && typeof item.quote.dp === 'number') {
      return item.quote.dp > 0 ? 'green' : item.quote.dp < 0 ? 'red' : 'black';
    }
    return 'black';
  }
  formatChangePercent(item: WatchlistItem): string {
    if (item.quote && typeof item.quote.dp === 'number') {
      return item.quote.dp.toFixed(2);
    }
    return '0.00';
  }

  formatChangeValue(item: WatchlistItem): string {
    if (item.quote && typeof item.quote.dp === 'number') {
      const changeValue = item.quote.dp > 0 ? `+${item.quote.d}` : item.quote.d.toString();
      return changeValue;
    }
    return '0.00';
  }

  getCompanyProfile(ticker: string): Observable<CompanyProfile> {
    return this.http.get<CompanyProfile>(`/company_profile?symbol=${encodeURIComponent(ticker)}`);
  }

  getCompanyQuote(ticker: string): Observable<QuoteResponse> {
    return this.http.get<QuoteResponse>(`/company_quote?symbol=${encodeURIComponent(ticker)}`);
  }

  removeStock(ticker: string): void {
    this.http.delete(`/api/watchlist/${ticker}`).subscribe(() => {
      this.loadWatchlist();
    });
  }




}
