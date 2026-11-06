import { HttpErrorResponse } from '@angular/common/http';
import { EMPTY, distinctUntilChanged, fromEvent, map, merge, retry, skip, startWith, switchMap, timer } from 'rxjs';

export function activeRefreshes(document: Document, intervalMs: number) {
  const browser = document.defaultView;
  if (!browser) return EMPTY;

  return merge(fromEvent(document, 'visibilitychange'), fromEvent(browser, 'online'), fromEvent(browser, 'offline')).pipe(
    startWith(null),
    map(() => !document.hidden && browser.navigator.onLine !== false),
    distinctUntilChanged(),
    switchMap((active, index) => active ? timer(index === 0 ? intervalMs : 0, intervalMs) : EMPTY),
  );
}

export function retryAfterTime(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  const until = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(until) ? Math.max(now + 1000, until) : null;
}

export function publicReadRetryTime(error: HttpErrorResponse, now: number): number | null {
  if (![429, 502, 503, 504].includes(error.status)) return null;
  return retryAfterTime(error.headers?.get('Retry-After') ?? null, now) ?? now + (error.status === 429 ? 60_000 : 3000);
}

export function retryPublicReadOnce<T>(onWait: (seconds: number) => void) {
  return retry<T>({ count: 1, delay: (error: HttpErrorResponse) => {
    const now = Date.now();
    const until = publicReadRetryTime(error, now);
    if (until === null) throw error;
    onWait(Math.ceil((until - now) / 1000));
    return timer(until - now);
  } });
}

const marketDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', dateStyle: 'short' });

export function marketDayKey(now = Date.now()): string {
  return marketDayFormat.format(now);
}

export function dailyRefreshes(document: Document) {
  const publicationDay = () => marketDayKey(Date.now() - 5 * 60_000);
  return activeRefreshes(document, 5 * 60_000).pipe(
    map(publicationDay),
    startWith(publicationDay()),
    distinctUntilChanged(),
    skip(1),
  );
}

export function visibleQuoteSymbols(host: HTMLElement, limit: number): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-quote-symbol]'))
    .filter(inViewport).slice(0, limit).map(row => row.dataset['quoteSymbol']!);
}

export function inViewport(element: Element): boolean {
  const viewport = element.ownerDocument.defaultView?.innerHeight ?? 0;
  const bounds = element.getBoundingClientRect();
  return bounds.height > 0 && bounds.top < viewport && bounds.bottom > 0;
}
