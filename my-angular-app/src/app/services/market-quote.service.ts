import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, defer, finalize, map, of, shareReplay } from 'rxjs';
import { retryAfterTime } from './market-refresh';

export interface MarketQuote {
  c: number;
  t: number;
  d: number | null;
  dp: number | null;
  h: number | null;
  l: number | null;
  o: number | null;
  pc: number | null;
}

export interface QuoteSnapshot {
  quote: MarketQuote | null;
  previous: boolean;
}

interface CachedQuote extends QuoteSnapshot {
  expiresAt: number;
  failures: number;
}

export const quoteRefreshMs = 30_000;
export const listQuoteRefreshMs = 60_000;
export const quoteBatchLimit = 6;
const quoteReuseMs = 25_000;
const unchangedQuoteReuseMs = 90_000;
const maximumRetryMs = 300_000;

@Injectable({ providedIn: 'root' })
export class MarketQuoteService {
  private readonly latest = new Map<string, CachedQuote>();
  private readonly pending = new Map<string, Observable<QuoteSnapshot>>();
  private providerRetryAt = 0;

  constructor(private http: HttpClient) {}

  read(symbol: string): Observable<QuoteSnapshot> {
    const ticker = symbol.trim().toUpperCase();
    return defer(() => {
      const cached = this.latest.get(ticker);
      const now = Date.now();
      if (cached && cached.expiresAt > now) return of(cached);
      const inFlight = this.pending.get(ticker);
      if (inFlight) return inFlight;
      if (this.providerRetryAt > now) return of({ quote: cached?.quote ?? null, previous: Boolean(cached?.quote) });

      const request = this.http.get<MarketQuote>('/company_quote', { params: { symbol: ticker } }).pipe(
        map(quote => this.record(ticker, quote)),
        catchError((error: HttpErrorResponse) => of(this.recordFailure(ticker, error))),
        finalize(() => { if (this.pending.get(ticker) === request) this.pending.delete(ticker); }),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.pending.set(ticker, request);
      return request;
    });
  }

  private record(ticker: string, quote: MarketQuote): QuoteSnapshot {
    const previous = this.latest.get(ticker)?.quote;
    if (!quote || !Number.isFinite(quote.c) || quote.c <= 0 || !Number.isSafeInteger(quote.t) || quote.t <= 0
      || quote.t > Date.now() / 1000 + 60 || (previous && quote.t < previous.t)) return this.recordFailure(ticker);

    const unchanged = previous?.t === quote.t && previous.c === quote.c;
    return this.remember(ticker, { quote, previous: false,
      expiresAt: Date.now() + (unchanged ? unchangedQuoteReuseMs : quoteReuseMs), failures: 0 });
  }

  private recordFailure(ticker: string, error?: HttpErrorResponse): QuoteSnapshot {
    const cached = this.latest.get(ticker);
    const failures = (cached?.failures ?? 0) + 1;
    const now = Date.now();
    const delay = Math.min(maximumRetryMs, quoteRefreshMs * 2 ** Math.min(failures - 1, 4));
    const explicit = retryAfterTime(error?.headers?.get('Retry-After') ?? null, now);
    const expiresAt = Math.max(now + delay, explicit ?? 0);
    if (error?.status === 429 || (error?.status === 503 && explicit !== null)) {
      this.providerRetryAt = Math.max(this.providerRetryAt, explicit ?? expiresAt);
    }
    return this.remember(ticker, { quote: cached?.quote ?? null, previous: Boolean(cached?.quote), expiresAt, failures });
  }

  private remember(ticker: string, snapshot: CachedQuote): CachedQuote {
    this.latest.delete(ticker);
    this.latest.set(ticker, snapshot);
    if (this.latest.size > 150) {
      const oldest = this.latest.keys().next().value;
      if (oldest !== undefined) this.latest.delete(oldest);
    }
    return snapshot;
  }
}
