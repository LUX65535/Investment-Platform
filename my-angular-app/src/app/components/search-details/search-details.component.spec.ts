import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';
import { PortfolioService } from '../../services/portfolio.service';
import { MarketResearchChartComponent } from '../market-research-chart/market-research-chart.component';
import { SearchDetailsComponent } from './search-details.component';

describe('SearchDetailsComponent recovery', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let component: SearchDetailsComponent;
  const now = Date.now();
  const bars = [100, 102, 104].map((c, index) => ({
    t: now - (3 - index) * 86_400_000, c, o: c - 1, h: c + 1, l: c - 2, v: 100, n: 10, vw: c,
  }));

  beforeEach(() => {
    const portfolio = jasmine.createSpyObj<PortfolioService>('PortfolioService', ['checkStock', 'checkWatchlist']);
    portfolio.checkStock.and.returnValue(of({ ticker: 'AAPL', quantity: 0 }));
    portfolio.checkWatchlist.and.returnValue(of(false));
    TestBed.configureTestingModule({
      imports: [SearchDetailsComponent],
      providers: [
        provideRouter([{ path: 'search-details/:ticker', component: SearchDetailsComponent }]),
        provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(),
        { provide: PortfolioService, useValue: portfolio },
      ],
    });
    // Exercise the real template and HTTP services without loading the chart renderer.
    spyOn(SearchDetailsComponent.prototype as unknown as { loadChartRuntime(): void }, 'loadChartRuntime').and.stub();
    spyOn(MarketResearchChartComponent.prototype, 'loadRuntime').and.stub();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function open(ticker = 'AAPL'): void {
    RouterTestingHarness.create(`/search-details/${ticker}`).then(created => harness = created);
    tick();
    component = harness.routeDebugElement!.componentInstance as SearchDetailsComponent;
    company(ticker);
  }

  function company(ticker: string): void {
    http.expectOne(`/company_profile?symbol=${ticker}`).flush({
      ticker, name: `${ticker} Company`, instrumentType: ticker === 'SOXL' ? 'ETF' : 'stock', currency: 'USD', country: 'US', exchange: 'NASDAQ',
      ipo: '2000-01-01', marketCapitalization: 1000, shareOutstanding: 10,
      logo: '', phone: '', weburl: 'https://example.com', finnhubIndustry: 'Technology',
    });
    http.expectOne(`/company_quote?symbol=${ticker}`).flush({
      c: 104, d: 2, dp: 2, t: Math.floor(now / 1000), h: 105, l: 100, o: 101, pc: 102,
    });
    http.expectOne(`/company_peers?symbol=${ticker}`).flush([]);
    harness.detectChanges();
  }

  function daily(ticker = 'AAPL') {
    return http.expectOne(`/market_history?symbol=${ticker}&range=1M&interval=1d`);
  }

  function hourly() {
    return http.expectOne(request => request.url === '/company_OneDay_data');
  }

  function view(): HTMLElement {
    harness.detectChanges();
    return harness.routeNativeElement!;
  }

  function button(label: string): HTMLButtonElement {
    return Array.from(view().querySelectorAll('button')).find(element =>
      element.textContent?.replace(/\s+/g, ' ').trim().startsWith(label))!;
  }

  function close(): void {
    harness.fixture.destroy();
  }

  it('retries only missing insights while keeping successful panels visible', fakeAsync(() => {
    open();
    daily().flush({ results: bars });
    component.setActiveTab('insights');
    tick();
    http.expectOne('/company_Earning?symbol=AAPL').flush(null, { status: 503, statusText: 'Unavailable' });
    http.expectOne('/company_recommendation?symbol=AAPL').flush([]);
    http.expectOne('/company_sentiment?symbol=AAPL').flush({ data: [{ mspr: 5, change: 20 }], symbol: 'AAPL' });
    expect(view().querySelector('.sentiment-table')?.textContent).toContain('20');
    expect(button('Retry missing insights')).toBeDefined();

    button('Retry missing insights').click();
    expect(view().querySelector('.sentiment-table')?.textContent).toContain('20');
    expect(button('Retry missing insights').disabled).toBeTrue();
    http.expectNone('/company_recommendation?symbol=AAPL');
    http.expectNone('/company_sentiment?symbol=AAPL');
    http.expectOne('/company_Earning?symbol=AAPL').flush(null, { status: 503, statusText: 'Unavailable' });
    expect(view().querySelector('.sentiment-table')?.textContent).toContain('20');

    button('Retry missing insights').click();
    http.expectOne('/company_Earning?symbol=AAPL').flush([{ period: '2026-09-30', actual: 2, estimate: 1.9, surprise: .1 }]);
    expect(component.earnings.length).toBe(1);
    expect(component.failedInsights.size).toBe(0);
    expect(button('Retry missing insights')).toBeUndefined();
    close();
  }));

  it('retains the full-section retry when every insight request fails', fakeAsync(() => {
    open();
    daily().flush({ results: bars });
    component.setActiveTab('insights');
    tick();
    for (const endpoint of ['company_Earning', 'company_recommendation', 'company_sentiment']) {
      http.expectOne(`/${endpoint}?symbol=AAPL`).flush(null, { status: 503, statusText: 'Unavailable' });
    }
    expect(component.failedTabs.has('insights')).toBeTrue();
    button('Try again').click();
    http.expectOne('/company_Earning?symbol=AAPL').flush([]);
    http.expectOne('/company_recommendation?symbol=AAPL').flush([]);
    http.expectOne('/company_sentiment?symbol=AAPL').flush({ data: [], symbol: 'AAPL' });
    expect(component.failedTabs.has('insights')).toBeFalse();
    expect(component.failedInsights.size).toBe(0);
    close();
  }));

  it('cancels prices for the previous symbol when switching quickly', fakeAsync(() => {
    open();
    const oldPrices = daily();
    harness.navigateByUrl('/search-details/MSFT', SearchDetailsComponent);
    tick();
    expect(oldPrices.cancelled).toBeTrue();
    company('MSFT');
    daily('MSFT').flush({ results: bars });
    expect(component.searchResults?.ticker).toBe('MSFT');
    expect(view().querySelector('app-market-research-chart')?.textContent).toContain('MSFT');
    expect(view().querySelector('h1')?.textContent).toContain('MSFT Company');
    close();
  }));

  it('falls back to a normalized ticker when lowercase autocomplete fails', fakeAsync(() => {
    open();
    daily().flush({ results: bars });
    component.submitSearch('msft');
    http.expectOne('/Autocomplete_Search?symbol=msft').flush(null, { status: 503, statusText: 'Unavailable' });
    tick();
    company('MSFT');
    daily('MSFT').flush({ results: bars });
    expect(component.searchResults?.ticker).toBe('MSFT');
    expect(component.suggestionsError).toBeFalse();
    close();
  }));

  it('shows ETF research and clears or dismisses search notices', fakeAsync(() => {
    open('SOXL');
    daily('SOXL').flush({ results: bars, visibleFrom: 0, visibleTo: now });
    expect(view().textContent).toContain('Fund profile');
    component.searchError = 'Previous lookup failed';
    expect(view().querySelector('[aria-label="Dismiss search notice"]')).not.toBeNull();
    (view().querySelector('[aria-label="Dismiss search notice"]') as HTMLButtonElement).click();
    expect(component.searchError).toBe('');
    component.searchError = 'Previous lookup failed';
    component.tickerFormControl.setValue('MSFT');
    expect(component.searchError).toBe('');
    tick(250); http.expectOne('/Autocomplete_Search?symbol=MSFT').flush({ result: [] });
    close();
  }));

  it('keeps range and interval consistent between Overview and the full-width chart', fakeAsync(() => {
    open(); daily().flush({ results: bars });
    component.setResearchSelection({ range: '5D', interval: '15m' });
    tick(); view();
    http.expectOne('/market_history?symbol=AAPL&range=5D&interval=15m').flush({ results: bars, range: '5D', interval: '15m' });
    component.setActiveTab('charts'); tick();
    expect(view().querySelector('app-market-research-chart')?.textContent).toContain('15 min');
    http.expectNone('/market_history?symbol=AAPL&range=5D&interval=15m');
    expect(component.researchSelection).toEqual({ range: '5D', interval: '15m' });
    close();
  }));

  it('shows verified quotes and history when optional security reference data is unavailable', fakeAsync(() => {
    RouterTestingHarness.create('/search-details/SOXL').then(created => harness = created);
    tick(); component = harness.routeDebugElement!.componentInstance as SearchDetailsComponent;
    http.expectOne('/company_profile?symbol=SOXL').flush(null, { status: 503, statusText: 'Unavailable' });
    http.expectOne('/company_quote?symbol=SOXL').flush({ c: 30, d: 1, dp: 3.45, t: Math.floor(now / 1000), o: 29, h: 31, l: 28, pc: 29 });
    http.expectOne('/company_peers?symbol=SOXL').flush([]);
    view(); daily('SOXL').flush({ results: bars });
    expect(component.searchResults?.ticker).toBe('SOXL');
    expect(component.searchResults?.currency).toBe('');
    expect(component.searchError).toBe('');
    expect(view().querySelector('app-market-research-chart')).not.toBeNull();
    close();
  }));

  it('immediately recovers a previously missing ETF quote on an explicit same-symbol search', fakeAsync(() => {
    RouterTestingHarness.create('/search-details/SOXL').then(created => harness = created);
    tick(); component = harness.routeDebugElement!.componentInstance as SearchDetailsComponent;
    http.expectOne('/company_profile?symbol=SOXL').flush(null, { status: 404, statusText: 'Not found' });
    http.expectOne('/company_quote?symbol=SOXL').flush(null, { status: 404, statusText: 'Not found' });
    expect(component.currentStock).toBeNull();
    component.searchError = '';
    component.submitSearch('SOXL');
    http.expectOne('/Autocomplete_Search?symbol=SOXL').flush({ result: [{ symbol: 'SOXL', displaySymbol: 'SOXL', description: 'Semiconductor ETF', type: 'ETF' }] });
    tick(); company('SOXL'); daily('SOXL').flush({ results: bars });
    expect(component.currentStock?.c).toBe(104);
    expect(component.quoteRefreshFailed).toBeFalse();
    expect(component.searchError).toBe('');
    expect(button('Paper buy').disabled).toBeFalse();
    close();
  }));
});
