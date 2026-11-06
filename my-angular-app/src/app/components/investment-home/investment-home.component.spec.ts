import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { InvestmentHomeComponent } from './investment-home.component';

describe('InvestmentHomeComponent', () => {
  let fixture: ComponentFixture<InvestmentHomeComponent>;
  let http: HttpTestingController;
  let view: HTMLElement;
  const path = '/company_data?symbol=SPY';

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [InvestmentHomeComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(InvestmentHomeComponent);
    view = fixture.nativeElement;
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('/api/market-overview').flush({
      session: '2026-11-03', previousSession: '2026-11-02', stale: false, screened: 3, comparable: 3,
      up: 2, down: 1, unchanged: 0, benchmarks: [], active: [], sectors: [],
    });
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  function close(day: string, c: number, hour = '04'): { t: number; c: number } {
    return { t: Date.parse(day + 'T' + hour + ':00:00Z'), c };
  }

  function prices(...results: ReturnType<typeof close>[]): void {
    http.expectOne(path).flush({ results });
    fixture.detectChanges();
  }

  it('uses distinct valid session closes and keeps the date and change together', () => {
    prices(
      close('2026-11-03', 110), close('2026-10-05', 100), close('2026-10-28', 101),
      close('2026-10-29', 102), close('2026-10-30', 103), close('2026-11-02', 100),
      close('2026-11-03', 105, '00'), close('2026-11-04', 0),
    );
    const data = fixture.componentInstance.benchmark!;
    expect(data.date).toBe(close('2026-11-03', 110).t);
    expect(data.close).toBe(110);
    expect(data.recentSessions.length).toBe(6);
    expect(data.recentSessions[0].change).toBeCloseTo(10, 8);
    expect(data.returns.map(period => Math.round(period.value ?? -1))).toEqual([10, 10, 10]);
    expect(data.bars.at(-1)?.c).toBe(110);
  });

  it('shows sparse data with its true chart dates and omits unsupported longer returns', () => {
    prices(close('2026-11-02', 100), close('2026-11-03', 110));
    const data = fixture.componentInstance.benchmark!;
    expect(data.returns[0].value).toBeCloseTo(10, 8);
    expect(data.returns.slice(1).map(period => period.value)).toEqual([null, null]);
    expect(data.bars.map(bar => bar.t)).toEqual([close('2026-11-02', 100).t, close('2026-11-03', 110).t]);
  });

  it('summarizes a balanced close only when the snapshot has the supporting quotes and comparisons', () => {
    prices();
    const market = {
      ...fixture.componentInstance.breadth!,
      comparable: 125,
      screened: 125,
      up: 51,
      down: 50,
      unchanged: 24,
      benchmarks: ['SPY', 'QQQ', 'IWM'].map(symbol => ({ symbol, close: 100, change: .5, volume: null })),
    };
    const note = () => view.querySelector('.home-heading p')?.textContent?.trim();
    function show(overview: typeof market): void {
      fixture.componentInstance.loadBreadth();
      http.expectOne('/api/market-overview').flush(overview);
      fixture.detectChanges();
    }
    show(market);
    expect(note()).toBe('All three benchmark ETFs rose, while advances and declines were nearly even.');
    show({ ...market, benchmarks: market.benchmarks.slice(0, 2) });
    expect(note()).toBe('Advances and declines were nearly even.');
    show({ ...market, comparable: 0, up: 0, down: 0, unchanged: 0, benchmarks: [] });
    expect(note()).toBe('U.S. equities and ETFs at the close.');
  });

  it('waits for a public provider cooldown, retries once, and preserves the manual retry after a second failure', fakeAsync(() => {
    http.expectOne(path).flush(null, { status: 429, statusText: 'Too Many Requests' });
    fixture.detectChanges();
    expect(view.textContent).toContain('Retrying after 60 seconds');
    tick(59_999); http.expectNone(path);
    tick(1);
    http.expectOne(path).flush(null, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(view.textContent).toContain('temporarily unavailable');
    view.querySelector<HTMLButtonElement>('.state-action')?.click();
    prices();
    expect(view.textContent).toContain('No SPY daily prices');
    expect(view.querySelector('app-benchmark-candles')).toBeNull();
    fixture.destroy();
  }));
});
