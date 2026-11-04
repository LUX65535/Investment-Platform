import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, firstValueFrom, of, timeout } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class MarketModeService {
  private readonly http = inject(HttpClient);
  mode: 'sample' | 'live' | null = null;

  get sample(): boolean { return this.mode === 'sample'; }
  get live(): boolean { return this.mode === 'live'; }
  get quoteSource(): string {
    if (this.live) return 'Finnhub';
    return this.sample ? 'Simulated data' : 'Quote';
  }
  get historySource(): string {
    if (this.live) return 'Polygon';
    return this.sample ? 'Simulated data' : 'Price history';
  }

  async load(): Promise<void> {
    const result = await firstValueFrom(this.http.get<{ mode: string }>('/company_market_mode').pipe(
      timeout(2500), catchError(() => of(null)),
    ));
    if (result?.mode === 'sample' || result?.mode === 'live') this.mode = result.mode;
  }
}
