import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, defer, finalize, map, of, shareReplay, tap, throwError } from 'rxjs';
import { marketDayKey, retryAfterTime } from './market-refresh';
import type { ResearchInterval, ResearchRange } from '../components/market-research-chart/market-studies';

export interface ResearchHistory {
  results: MarketBar[];
  range: ResearchRange;
  interval: ResearchInterval;
  visibleFrom: number;
  visibleTo: number | null;
  availableIntervals?: ResearchInterval[];
  coverage?: { from: number | null; to: number | null; warmupBars: number; complete: boolean; adjustment: string;
    requestedWarmupBars?: number; warmupLimited?: boolean; message?: string };
  availability?: { status: 'available' | 'empty'; message?: string };
}

export interface MarketBar {
  c: number;
  h: number;
  l: number;
  n?: number;
  o: number;
  t: number;
  v?: number;
  vw?: number;
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
  private readonly researchCache = new Map<string, { expires: number; value: ResearchHistory }>();
  private readonly researchPending = new Map<string, Observable<ResearchHistory>>();
  private readonly recent = new Map<string, { expires: number; day: string; value: { results: MarketBar[] } }>();
  private readonly pending = new Map<string, Observable<{ results: MarketBar[] }>>();
  private retryAt = 0;

  constructor(private http: HttpClient) {}

  history(symbol: string, range: ResearchRange, interval: ResearchInterval, refresh = false): Observable<ResearchHistory> {
    const ticker = symbol.trim().toUpperCase();
    const key = `${ticker}:${range}:${interval}`;
    return defer(() => {
      const now = Date.now();
      const pending = this.researchPending.get(key);
      if (pending) return pending;
      const cached = this.researchCache.get(key);
      if (!refresh && cached && cached.expires > now) return of(cached.value);
      if (this.retryAt > now) return throwError(() => new HttpErrorResponse({ status: 503,
        headers: new HttpHeaders({ 'Retry-After': String(Math.ceil((this.retryAt - now) / 1000)) }) }));
      const request = this.http.get<ResearchHistory>('/market_history', { params: { symbol: ticker, range, interval } }).pipe(
        map(value => ({ ...value, results: [...new Map(validClosingBars(value.results).map(bar => [bar.t, bar])).values()] })),
        tap(value => {
          if (!value.results.length) return;
          this.researchCache.delete(key);
          this.researchCache.set(key, { expires: Date.now() + (['1m', '5m', '15m', '1h'].includes(interval) ? 60_000 : 300_000), value });
          if (this.researchCache.size > 30) this.researchCache.delete(this.researchCache.keys().next().value!);
        }),
        catchError((error: HttpErrorResponse) => {
          const explicit = retryAfterTime(error.headers?.get('Retry-After') ?? null, Date.now());
          if (error.status === 429 || error.status === 503 && explicit !== null) this.retryAt = Math.max(this.retryAt, explicit ?? Date.now() + 30_000);
          return throwError(() => error);
        }),
        finalize(() => { if (this.researchPending.get(key) === request) this.researchPending.delete(key); }),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.researchPending.set(key, request);
      return request;
    });
  }

  daily(symbol: string, refresh = false): Observable<{ results: MarketBar[] }> {
    const ticker = symbol.trim().toUpperCase();
    return defer(() => {
      const now = Date.now();
      const day = marketDayKey(now - 5 * 60_000);
      const inFlight = this.pending.get(ticker);
      if (inFlight) return inFlight;
      const existing = this.recent.get(ticker);
      if (!refresh && existing && existing.day === day && existing.expires > now) return of(existing.value);
      if (this.retryAt > now) {
        return throwError(() => new HttpErrorResponse({
          status: 503,
          statusText: 'Price history is temporarily unavailable',
          headers: new HttpHeaders({ 'Retry-After': String(Math.max(1, Math.ceil((this.retryAt - now) / 1000))) }),
        }));
      }

      const request = this.http.get<{ results?: MarketBar[] }>('/company_data', { params: { symbol: ticker } }).pipe(
        map(response => ({ results: validClosingBars(response?.results) })),
        tap(value => {
          this.recent.delete(ticker);
          this.recent.set(ticker, { expires: Date.now() + 5 * 60_000, day, value });
          if (this.recent.size > 12) {
            const oldest = this.recent.keys().next().value;
            if (oldest !== undefined) this.recent.delete(oldest);
          }
        }),
        catchError((error: HttpErrorResponse) => {
          const explicit = retryAfterTime(error.headers?.get('Retry-After') ?? null, Date.now());
          if (error.status === 429 || (error.status === 503 && explicit !== null)) {
            this.retryAt = Math.max(this.retryAt, explicit ?? Date.now() + 30_000);
          }
          return throwError(() => error);
        }),
        finalize(() => { if (this.pending.get(ticker) === request) this.pending.delete(ticker); }),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.pending.set(ticker, request);

      return request;
    });
  }
}
