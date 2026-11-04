import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, map, shareReplay, throwError } from 'rxjs';

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

export function validClosingBars(data: unknown): MarketBar[] {
  if (!Array.isArray(data)) return [];
  return data.filter(bar => Number.isFinite(bar?.t) && Number.isFinite(bar.c) && bar.c > 0)
    .sort((a, b) => a.t - b.t);
}

@Injectable({ providedIn: 'root' })
export class MarketHistoryService {
  private readonly recent = new Map<string, { expires: number; request: Observable<{ results: MarketBar[] }> }>();

  constructor(private http: HttpClient) {}

  daily(ticker: string): Observable<{ results: MarketBar[] }> {
    const existing = this.recent.get(ticker);
    const now = Date.now();
    if (existing && existing.expires > now) return existing.request;

    const request = this.http.get<{ results?: MarketBar[] }>('/company_data', { params: { symbol: ticker } }).pipe(
      map(response => ({ results: validClosingBars(response?.results) })),
      catchError(error => {
        if (this.recent.get(ticker)?.request === request) this.recent.delete(ticker);
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    this.recent.delete(ticker);
    this.recent.set(ticker, { expires: now + 5 * 60_000, request });
    if (this.recent.size > 12) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
    return request;
  }
}