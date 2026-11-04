import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, map, shareReplay, throwError } from 'rxjs';
import { marketDayKey, retryAfterTime } from './market-refresh';

export interface MarketBar {
  c: number;
  h: number;
  l: number;
  n: number;
  o: number;
  t: number;
  v: number;
  vw: number;
}

export function utcDayMonthsBefore(end: number, months: number): number {
  const date = new Date(end);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() - months;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(date.getUTCDate(), daysInMonth));
}

export function alignedPriceReturns(stock: MarketBar[], benchmark: MarketBar[]): Array<[number, number, number]> {
  const marketDay = (time: number) => Math.floor(time / 86_400_000) * 86_400_000;
  const benchmarkCloses = new Map(benchmark.map(bar => [marketDay(bar.t), bar.c]));
  const stockCloses = new Map(stock.map(bar => [marketDay(bar.t), bar.c]));
  const aligned: Array<[number, number, number]> = [];
  let firstStock = 0;
  let firstBenchmark = 0;
  for (const [day, close] of stockCloses) {
    const benchmarkClose = benchmarkCloses.get(day);
    if (benchmarkClose === undefined) continue;
    if (!aligned.length) {
      firstStock = close;
      firstBenchmark = benchmarkClose;
    }
    aligned.push([day, (close / firstStock - 1) * 100, (benchmarkClose / firstBenchmark - 1) * 100]);
  }
  return aligned;
}

export function validClosingBars(data: unknown): MarketBar[] {
  if (!Array.isArray(data)) return [];
  return data.filter(bar => Number.isFinite(bar?.t) && Number.isFinite(bar.c) && bar.c > 0)
    .sort((a, b) => a.t - b.t);
}

@Injectable({ providedIn: 'root' })
export class MarketHistoryService {
  private readonly recent = new Map<string, { expires: number; day: string; request: Observable<{ results: MarketBar[] }> }>();
  private retryAt = 0;

  constructor(private http: HttpClient) {}

  daily(symbol: string): Observable<{ results: MarketBar[] }> {
    const ticker = symbol.trim().toUpperCase();
    const existing = this.recent.get(ticker);
    const now = Date.now();
    const day = marketDayKey(now - 5 * 60_000);
    if (existing && existing.day === day && existing.expires > now) return existing.request;
    if (this.retryAt > now) return throwError(() => new HttpErrorResponse({ status: 503, statusText: 'Price history is temporarily unavailable' }));

    const request = this.http.get<{ results?: MarketBar[] }>('/company_data', { params: { symbol: ticker } }).pipe(
      map(response => ({ results: validClosingBars(response?.results) })),
      catchError((error: HttpErrorResponse) => {
        if (this.recent.get(ticker)?.request === request) this.recent.delete(ticker);
        const explicit = retryAfterTime(error.headers?.get('Retry-After') ?? null, Date.now());
        if (error.status === 429 || (error.status === 503 && explicit !== null)) {
          this.retryAt = Math.max(this.retryAt, explicit ?? Date.now() + 30_000);
        }
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    this.recent.delete(ticker);
    this.recent.set(ticker, { expires: now + 5 * 60_000, day, request });
    if (this.recent.size > 12) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
    return request;
  }
}
