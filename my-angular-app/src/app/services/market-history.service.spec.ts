import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MarketBar, MarketHistoryService } from './market-history.service';

describe('MarketHistoryService recovery', () => {
  let service: MarketHistoryService;
  let http: HttpTestingController;
  const history = (price: number) => ({ results: [{ t: Date.UTC(2026, 9, 30), c: price } as MarketBar] });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(MarketHistoryService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reuses successful data but a manual refresh requests fresh prices and shares in-flight work', () => {
    const prices: number[] = [];
    service.daily(' aapl ').subscribe(value => prices.push(value.results[0].c));
    service.daily('AAPL').subscribe(value => prices.push(value.results[0].c));
    http.expectOne('/company_data?symbol=AAPL').flush(history(100));
    service.daily('AAPL').subscribe(value => prices.push(value.results[0].c));
    http.expectNone('/company_data?symbol=AAPL');
    service.daily('AAPL', true).subscribe(value => prices.push(value.results[0].c));
    service.daily('AAPL', true).subscribe(value => prices.push(value.results[0].c));
    http.expectOne('/company_data?symbol=AAPL').flush(history(105));
    expect(prices).toEqual([100, 100, 100, 105, 105]);
  });

  it('preserves cooldown information across symbols and allows a real retry after it expires', fakeAsync(() => {
    let error: HttpErrorResponse | undefined;
    service.daily('AAPL').subscribe({ error: value => error = value });
    http.expectOne('/company_data?symbol=AAPL').flush({}, {
      status: 503, statusText: 'Unavailable', headers: { 'Retry-After': '60' },
    });
    tick(20_000);
    service.daily('MSFT', true).subscribe({ error: value => error = value });
    http.expectNone('/company_data?symbol=MSFT');
    expect(error?.status).toBe(503);
    expect(error?.headers.get('Retry-After')).toBe('40');
    tick(40_000);
    let price = 0;
    service.daily('AAPL', true).subscribe(value => price = value.results[0].c);
    http.expectOne('/company_data?symbol=AAPL').flush(history(110));
    expect(price).toBe(110);
  }));

  it('retains the last successful cache when a refresh fails and never caches the failure', () => {
    service.daily('AAPL').subscribe();
    http.expectOne('/company_data?symbol=AAPL').flush(history(100));
    service.daily('AAPL', true).subscribe({ error: () => undefined });
    http.expectOne('/company_data?symbol=AAPL').flush({}, { status: 504, statusText: 'Gateway Timeout' });
    let price = 0;
    service.daily('AAPL').subscribe(value => price = value.results[0].c);
    http.expectNone('/company_data?symbol=AAPL');
    expect(price).toBe(100);
    service.daily('AAPL', true).subscribe(value => price = value.results[0].c);
    http.expectOne('/company_data?symbol=AAPL').flush(history(106));
    expect(price).toBe(106);
  });

  it('removes canceled requests so a later visit can fetch the symbol again', () => {
    const subscription = service.daily('AAPL').subscribe();
    const canceled = http.expectOne('/company_data?symbol=AAPL');
    subscription.unsubscribe();
    expect(canceled.cancelled).toBeTrue();
    let price = 0;
    service.daily('AAPL').subscribe(value => price = value.results[0].c);
    http.expectOne('/company_data?symbol=AAPL').flush(history(101));
    expect(price).toBe(101);
  });

  it('uses a bounded fallback cooldown for a 429 without Retry-After', fakeAsync(() => {
    service.daily('AAPL').subscribe({ error: () => undefined });
    http.expectOne('/company_data?symbol=AAPL').flush({}, { status: 429, statusText: 'Too Many Requests' });
    let error: HttpErrorResponse | undefined;
    service.daily('AAPL', true).subscribe({ error: value => error = value });
    http.expectNone('/company_data?symbol=AAPL');
    expect(error?.headers.get('Retry-After')).toBe('30');
    tick(30_000);
    service.daily('AAPL', true).subscribe();
    http.expectOne('/company_data?symbol=AAPL').flush(history(103));
  }));
});
