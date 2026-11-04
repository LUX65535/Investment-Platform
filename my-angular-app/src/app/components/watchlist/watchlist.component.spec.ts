import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { PortfolioService } from '../../services/portfolio.service';
import { WatchlistComponent } from './watchlist.component';

describe('WatchlistComponent', () => {
  let fixture: ComponentFixture<WatchlistComponent>;
  let http: HttpTestingController;
  let portfolio: jasmine.SpyObj<PortfolioService>;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    portfolio = jasmine.createSpyObj('PortfolioService', ['getWatchlist', 'removeWatchlist', 'addWatchlist']);
    TestBed.configureTestingModule({
      imports: [WatchlistComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: PortfolioService, useValue: portfolio },
      ],
    });
    fixture = TestBed.createComponent(WatchlistComponent);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function load(...tickers: string[]): void {
    portfolio.getWatchlist.and.returnValue(of(tickers.map(ticker => ({ ticker }))));
    fixture.detectChanges();
  }

  function profile(ticker: string, name: string): void {
    http.expectOne(`/company_profile?symbol=${ticker}`).flush({ name, currency: 'USD' });
  }

  function quote(ticker: string, value: number, percent: number, time: number): void {
    http.expectOne(`/company_quote?symbol=${ticker}`).flush({
      c: value, d: 1, dp: percent, l: value - 8.75, h: value + 1.25, o: value - 3.75, pc: value - 1, t: time,
    });
  }

  it('refreshes only visible quotes and preserves their original time if an update fails', fakeAsync(() => {
    load('AAPL');
    profile('AAPL', 'Apple Inc.');
    quote('AAPL', 198.75, 1.2, now - 300);
    fixture.detectChanges();

    const view: HTMLElement = fixture.nativeElement;
    const time = view.querySelector('time')?.getAttribute('datetime');
    expect(view.querySelector('.mover-summary')?.textContent).toContain('+1.20%');

    const row = view.querySelector('tbody tr')!;
    spyOn(row, 'getBoundingClientRect').and.returnValue(new DOMRect(0, 20, 100, 40));
    tick(60_000);
    fixture.detectChanges();
    expect(view.querySelector('.watchlist-price')?.textContent).toContain('198.75');
    expect(view.querySelector('.coverage-detail')?.textContent).toContain('Refreshing');
    expect(portfolio.getWatchlist).toHaveBeenCalledTimes(1);
    http.expectNone('/company_profile?symbol=AAPL');

    http.expectOne('/company_quote?symbol=AAPL').flush(null, { status: 429, statusText: 'Too Many Requests' });
    fixture.detectChanges();
    expect(view.querySelector('.watchlist-price')?.textContent).toContain('198.75');
    expect(view.querySelector('time')?.getAttribute('datetime')).toBe(time);
    expect(view.querySelector('.quote-state')?.textContent).toContain('Previous quote');
    expect(view.querySelector('.mover-summary')).toBeNull();
    expect(view.querySelector('.range-values')?.textContent).toBe('190.00–200.00');
    expect(view.querySelector('.desktop-levels')?.textContent).toContain('197.75');
    fixture.destroy();
  }));

  it('excludes older and unpriced symbols from the move summary and keeps them available to filter', () => {
    load('AAPL', 'MSFT', 'NVDA');
    profile('AAPL', 'Apple Inc.');
    profile('MSFT', 'Microsoft');
    profile('NVDA', 'NVIDIA');
    quote('AAPL', 198.75, -2.2, now - 300);
    quote('MSFT', 500.01, 6.2, now - 48 * 3600);
    http.expectOne('/company_quote?symbol=NVDA').flush(null, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();

    const view: HTMLElement = fixture.nativeElement;
    expect(view.querySelector('.coverage-summary strong')?.textContent).toContain('2 / 3');
    expect(view.querySelector('.mover-summary')?.textContent).toContain('AAPL');
    expect(view.querySelector('.mover-summary')?.textContent).toContain('Largest recent move');
    expect(view.querySelector('.market-breadth')?.textContent).toContain('1 down');
    expect(view.querySelector('.recent-count')?.textContent).toBe('1 of 3 recent');
    expect(view.querySelector('.quote-state')?.textContent).toContain('Older than 24h');
    expect(view.querySelector('.watchlist tbody')?.textContent).toContain('Quote unavailable');

    fixture.componentInstance.filter = 'microsoft';
    fixture.detectChanges();
    expect(view.querySelectorAll('.watchlist tbody tr').length).toBe(1);
    expect(view.querySelector('.watchlist tbody tr')?.textContent).toContain('MSFT');
  });

  it('renders observed session levels and leaves partial, contradictory, and out-of-range values unmarked', () => {
    load('AAPL', 'MSFT', 'NVDA');
    profile('AAPL', 'Apple Inc.');
    profile('MSFT', 'Microsoft');
    profile('NVDA', 'NVIDIA');
    http.expectOne('/company_quote?symbol=AAPL').flush({ c: 355, l: 330, h: 354.5, o: 336.44, pc: 331.9, t: now - 60 });
    http.expectOne('/company_quote?symbol=MSFT').flush({ c: 550, l: 0, h: 558.05, o: 0, pc: 520.99, t: now - 60 });
    http.expectOne('/company_quote?symbol=NVDA').flush({ c: 200, l: 225, h: 210, o: 220, t: now - 60 });
    fixture.detectChanges();

    const view: HTMLElement = fixture.nativeElement;
    const [apple, microsoft, nvidia] = Array.from(view.querySelectorAll('.watchlist tbody tr'));
    expect(apple.querySelector('.range-values')?.textContent).toBe('330.00–354.50');
    expect(apple.querySelector('.range-marker')).toBeNull();
    expect(apple.querySelector('.desktop-levels')?.textContent).toContain('Prev. close331.90');
    expect(microsoft.querySelector('.range-cell')?.textContent).toContain('High 558.05 only');
    expect(microsoft.querySelector('.range-track')).toBeNull();
    expect(microsoft.querySelector('.desktop-levels')?.textContent).toContain('Open—');
    expect(nvidia.querySelector('.range-cell')?.textContent).toContain('Range unavailable');
  });

  it('reloads saved symbols but reuses a recent quote and complete profile on quick return', () => {
    load('AAPL');
    profile('AAPL', 'Apple Inc.');
    quote('AAPL', 198.75, 1.2, now - 300);
    fixture.destroy();
    fixture = TestBed.createComponent(WatchlistComponent);
    fixture.detectChanges();

    expect(portfolio.getWatchlist).toHaveBeenCalledTimes(2);
    http.expectNone('/company_quote?symbol=AAPL');
    http.expectNone('/company_profile?symbol=AAPL');
    expect((fixture.nativeElement as HTMLElement).querySelector('.range-values')?.textContent).toContain('200.00');
  });

  it('separates retryable load failure from the empty watchlist', () => {
    portfolio.getWatchlist.and.returnValues(throwError(() => Error('offline')), of([]));
    fixture.detectChanges();

    const view: HTMLElement = fixture.nativeElement;
    expect(view.querySelector('[role=alert]')?.textContent).toContain('couldn’t load');
    expect(view.querySelector('.watchlist-empty')).toBeNull();
    view.querySelector<HTMLButtonElement>('.watch-notice button')!.click();
    fixture.detectChanges();
    expect(view.querySelector('[role=alert]')).toBeNull();
    expect(view.querySelector('.watchlist-empty')?.textContent).toContain('No saved symbols yet');
  });

  it('only exposes removal in Manage and can restore the last persisted removal', () => {
    load('AAPL');
    profile('AAPL', 'Apple Inc.');
    quote('AAPL', 198.75, 1.2, now - 300);
    portfolio.removeWatchlist.and.returnValue(of({}));
    portfolio.addWatchlist.and.returnValue(of({}));
    fixture.detectChanges();

    const view: HTMLElement = fixture.nativeElement;
    expect(view.querySelector('.remove-button')).toBeNull();
    view.querySelector<HTMLButtonElement>('.edit-button')!.click();
    fixture.detectChanges();
    const remove = view.querySelector<HTMLButtonElement>('.remove-button')!;
    remove.focus();
    remove.click();
    fixture.detectChanges();
    expect(portfolio.removeWatchlist).toHaveBeenCalledOnceWith('AAPL');
    expect(document.activeElement).toBe(view.querySelector('h1'));

    view.querySelector<HTMLButtonElement>('[aria-label="Restore AAPL to watchlist"]')!.click();
    fixture.detectChanges();
    expect(portfolio.addWatchlist).toHaveBeenCalledOnceWith('AAPL');
    expect(view.querySelector('.watchlist tbody')?.textContent).toContain('AAPL');
    expect(view.querySelector('.watch-notice')?.textContent).toContain('AAPL restored');
  });
});
