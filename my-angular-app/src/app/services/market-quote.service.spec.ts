import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MarketQuoteService, QuoteSnapshot } from './market-quote.service';
import { activeRefreshes } from './market-refresh';

describe('MarketQuoteService', () => {
  let service: MarketQuoteService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(MarketQuoteService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shares normalized in-flight quotes and slows down when the source timestamp and price stay unchanged', fakeAsync(() => {
    const snapshots: QuoteSnapshot[] = [];
    const observe = (ticker = 'AAPL') => service.read(ticker).subscribe(snapshot => snapshots.push(snapshot));
    const quote = { c: 180, t: Math.floor(Date.now() / 1000) };
    observe(' aapl ');
    observe();
    http.expectOne('/company_quote?symbol=AAPL').flush(quote);
    expect(snapshots.map(snapshot => snapshot.quote)).toEqual([jasmine.objectContaining(quote), jasmine.objectContaining(quote)]);

    tick(20_000);
    observe();
    http.expectNone('/company_quote?symbol=AAPL');
    tick(6_000);
    observe();
    http.expectOne('/company_quote?symbol=AAPL').flush(quote);
    tick(89_000);
    observe();
    http.expectNone('/company_quote?symbol=AAPL');
    tick(1_000);
    observe();
    http.expectOne('/company_quote?symbol=AAPL').flush({ ...quote, t: quote.t + 120 });
  }));

  it('retains the dated quote and pauses other symbols on provider Retry-After', fakeAsync(() => {
    let observed: QuoteSnapshot | undefined;
    const observe = (ticker = 'AAPL') => service.read(ticker).subscribe(snapshot => observed = snapshot);
    const quote = { c: 180, t: Math.floor(Date.now() / 1000) };
    observe();
    http.expectOne('/company_quote?symbol=AAPL').flush(quote);
    tick(26_000);
    observe();
    http.expectOne('/company_quote?symbol=AAPL').flush({}, {
      status: 503, statusText: 'Unavailable', headers: { 'Retry-After': '90' },
    });
    expect(observed).toEqual(jasmine.objectContaining({ quote: jasmine.objectContaining(quote), previous: true }));

    tick(89_000);
    observe('MSFT');
    http.expectNone('/company_quote?symbol=MSFT');
    tick(1_000);
    observe();
    http.expectOne('/company_quote?symbol=AAPL').flush({ c: 170, t: quote.t - 1 });
    expect(observed).toEqual(jasmine.objectContaining({ quote: jasmine.objectContaining(quote), previous: true }));
  }));

  it('lets explicit searches and retries bypass a cached failure while still sharing in-flight requests', () => {
    let observed: QuoteSnapshot | undefined;
    service.read('SOXL').subscribe(value => observed = value);
    http.expectOne('/company_quote?symbol=SOXL').flush({}, { status: 404, statusText: 'Not found' });
    expect(observed?.quote).toBeNull();
    service.read('SOXL').subscribe();
    http.expectNone('/company_quote?symbol=SOXL');

    service.read('SOXL', true).subscribe(value => observed = value);
    service.read(' soxl ', true).subscribe();
    http.expectOne('/company_quote?symbol=SOXL').flush({ c: 42.35, t: Math.floor(Date.now() / 1000) });
    expect(observed?.quote?.c).toBe(42.35);
    expect(observed?.previous).toBeFalse();
    service.read('SOXL').subscribe();
    http.expectNone('/company_quote?symbol=SOXL');
  });

  it('honors provider Retry-After even for an explicit refresh', fakeAsync(() => {
    let recovered: QuoteSnapshot | undefined;
    service.read('SOXL').subscribe();
    http.expectOne('/company_quote?symbol=SOXL').flush({}, { status: 429, statusText: 'Rate limited', headers: { 'Retry-After': '20' } });
    service.read('SOXL', true).subscribe();
    http.expectNone('/company_quote?symbol=SOXL');
    tick(20_000);
    service.read('SOXL', true).subscribe(value => recovered = value);
    http.expectOne('/company_quote?symbol=SOXL').flush({ c: 42.35, t: Math.floor(Date.now() / 1000) });
    expect(recovered?.quote?.c).toBe(42.35);
  }));
});

describe('Active market refreshes', () => {
  it('pauses while hidden or offline and revalidates once on a visible online return', fakeAsync(() => {
    const browser = Object.assign(new EventTarget(), { navigator: { onLine: true } });
    const document = Object.assign(new EventTarget(), { hidden: false, defaultView: browser });
    let reads = 0;
    const subscription = activeRefreshes(document as unknown as Document, 30_000).subscribe(() => reads++);
    tick(30_000);
    expect(reads).toBe(1);
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(90_000);
    expect(reads).toBe(1);

    browser.navigator.onLine = false;
    browser.dispatchEvent(new Event('offline'));
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(30_000);
    expect(reads).toBe(1);
    browser.navigator.onLine = true;
    browser.dispatchEvent(new Event('online'));
    tick();
    expect(reads).toBe(2);
    subscription.unsubscribe();
    tick(60_000);
    expect(reads).toBe(2);
  }));
});
