import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MarketResearchChartComponent } from './market-research-chart.component';

describe('Unified market research chart', () => {
  let fixture: ComponentFixture<MarketResearchChartComponent>;
  let component: MarketResearchChartComponent;
  let http: HttpTestingController;
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: Date.UTC(2026, 9, i + 1, 13, 30), c: 100 + i, o: 99 + i, h: 101 + i, l: 98 + i, v: 100, vw: 100 + i, n: 1 }));
  const payload = { results: bars, range: '1M', interval: '1d', visibleFrom: bars[20].t, visibleTo: bars[29].t, coverage: { complete: true, warmupBars: 20 } };
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MarketResearchChartComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    spyOn(MarketResearchChartComponent.prototype, 'loadRuntime').and.stub();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MarketResearchChartComponent);
    component = fixture.componentInstance;
  });
  afterEach(() => { fixture.destroy(); http.verify(); });
  function open() { fixture.componentRef.setInput('symbol', 'SOXL'); fixture.detectChanges(); }
  function request(symbol = 'SOXL', range = '1M', interval = '1d') { return http.expectOne(`/market_history?symbol=${symbol}&range=${range}&interval=${interval}`); }
  function button(label: string): HTMLButtonElement { fixture.detectChanges(); return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(value => value.textContent?.trim().startsWith(label))!; }

  it('uses warm-up history while rendering only the chosen range', () => {
    open(); request().flush(payload);
    expect(component.visibleBars.length).toBe(10);
    const sma = component.options.series!.find(series => series.name === 'SMA 20') as { data: number[][] };
    expect(sma.data[0]).toEqual([bars[20].t, 110.5]);
    expect(button('Max')).toBeDefined();
    component.settingsOpen = true; fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('MACD');
    expect(component.canVwap).toBeFalse();
  });
  it('cancels stale symbol/range requests and chooses valid intraday resolution', () => {
    open(); const previous = request();
    component.selectRange('1D');
    expect(previous.cancelled).toBeTrue();
    const hourly = request('SOXL', '1D', '5m');
    fixture.componentRef.setInput('symbol', 'MSFT'); fixture.detectChanges();
    expect(hourly.cancelled).toBeTrue();
    request('MSFT', '1D', '5m').flush({ ...payload, interval: '5m', range: '1D' });
    expect(component.options.series![0].name).toBe('MSFT');
  });
  it('labels the actual return period when a successful provider response covers only part of the range', () => {
    open();
    request().flush(payload);
    component.selectRange('5Y');
    const message = 'Available bars for the requested 5Y range run from 2024-11-03 to 2026-11-01.';
    request('SOXL', '5Y', '1d').flush({
      ...payload, range: '5Y',
      coverage: { complete: false, warmupLimited: true, message },
    });
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector('.period-result');
    expect(heading.textContent).toContain('available period');
    expect(heading.textContent).not.toContain('5Y');
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain(message);
  });
  it('preserves a valid chart during retry failures and respects Retry-After', fakeAsync(() => {
    open(); request().flush(payload); const chart = component.options;
    component.load(true); request().flush(null, { status: 503, statusText: 'Unavailable', headers: { 'Retry-After': '2' } });
    expect(component.options).toBe(chart);
    expect(button('Retry prices').disabled).toBeTrue();
    component.load(true); http.expectNone('/market_history?symbol=SOXL&range=1M&interval=1d');
    tick(2000); button('Retry prices').click(); request().flush(payload);
    expect(component.error).toBe(''); expect(component.visibleBars.length).toBe(10);
  }));
  it('clears range-specific errors and treats entitlement as unavailable, not empty prices', () => {
    open(); request().flush({ code: 'DATA_PLAN_LIMIT' }, { status: 403, statusText: 'Forbidden' });
    expect(component.error).toContain('data plan');
    expect(component.error).not.toContain('daily interval');
    expect(button('Retry prices')).toBeUndefined();
    (fixture.nativeElement.querySelector('[aria-label="Dismiss price notice"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.error).toBe('');
    expect(component.entitlementError).toBeTrue();
    expect(fixture.nativeElement.textContent).not.toContain('No prices in this selection');
    expect(button('Retry prices')).toBeUndefined();
    component.selectRange('3M'); expect(component.error).toBe('');
    request('SOXL', '3M').flush({ ...payload, range: '3M' });
    expect(component.entitlementError).toBeFalse();
  });
  it('shares cached history between chart mounts and forces fresh data on Retry', () => {
    open(); request().flush(payload); fixture.destroy();
    fixture = TestBed.createComponent(MarketResearchChartComponent); component = fixture.componentInstance; open();
    http.expectNone('/market_history?symbol=SOXL&range=1M&interval=1d');
    expect(component.visibleBars.length).toBe(10);
    component.load(true); request().flush(payload);
  });

  it('keeps invalid comparison input separate from retryable price failures', () => {
    open(); request().flush(payload);
    component.settingsOpen = true;
    component.comparisonInput = 'SOXL';
    component.compare();
    expect(component.comparisonInputError).toContain('different');
    expect(component.comparisonError).toBe('');
    expect(button('Retry comparison')).toBeUndefined();
    component.loadComparison(true);
    http.expectNone(value => value.url === '/market_history');
    button('Dismiss').click();
    expect(component.comparisonInputError).toBe('');
  });

  it('removes the old comparison immediately when its replacement fails and retries only the replacement', () => {
    open(); request().flush(payload);
    component.settingsOpen = true;
    component.comparisonInput = 'SPY'; component.compare();
    request('SPY').flush(payload);
    expect(component.options.series!.some(series => series.name === 'SPY return')).toBeTrue();
    component.comparisonInput = 'QQQ'; component.compare();
    expect(component.options.series!.some(series => series.name?.endsWith(' return'))).toBeFalse();
    request('QQQ').flush(null, { status: 503, statusText: 'Unavailable' });
    expect(component.options.series!.some(series => series.name === 'SPY return')).toBeFalse();
    expect(component.comparisonError).toContain('QQQ');
    button('Retry comparison').click(); request('QQQ').flush(payload);
    expect(component.comparisonError).toBe('');
    expect(component.options.series!.some(series => series.name === 'QQQ return')).toBeTrue();
  });

  it('removes stale comparison lines while a URL-selected replacement is loading', () => {
    open(); request().flush(payload);
    fixture.componentRef.setInput('comparisonTicker', 'SPY'); fixture.detectChanges();
    request('SPY').flush(payload);
    expect(component.options.series!.some(series => series.name === 'SPY return')).toBeTrue();
    fixture.componentRef.setInput('comparisonTicker', 'QQQ'); fixture.detectChanges();
    expect(component.options.series!.some(series => series.name?.endsWith(' return'))).toBeFalse();
    request('QQQ').flush(payload);
    expect(component.options.series!.some(series => series.name === 'QQQ return')).toBeTrue();
  });

  it('clears a previous comparison failure when the next submitted symbol is invalid', () => {
    open(); request().flush(payload);
    component.settingsOpen = true;
    component.comparisonInput = 'SPY'; component.compare(); request('SPY').flush(payload);
    component.comparisonInput = 'NOTFOUND'; component.compare();
    request('NOTFOUND').flush(null, { status: 404, statusText: 'Not found' });
    expect(button('Retry comparison')).toBeDefined();
    component.comparisonInput = 'SOXL'; component.compare();
    expect(component.comparisonInputError).toContain('different');
    expect(component.comparisonError).toBe('');
    expect(button('Retry comparison')).toBeUndefined();
    expect(fixture.nativeElement.textContent).not.toContain('Comparison prices for NOTFOUND are unavailable');
    expect(component.options.series!.some(series => series.name === 'SPY return')).toBeFalse();
    http.expectNone(value => value.url === '/market_history');
  });

  it('pauses off-screen intraday refreshes, resumes on re-entry, and disconnects its observer', fakeAsync(() => {
    fixture.destroy();
    fixture = TestBed.createComponent(MarketResearchChartComponent);
    component = fixture.componentInstance;
    let callback!: IntersectionObserverCallback;
    const observer = { observe: jasmine.createSpy('observe'), disconnect: jasmine.createSpy('disconnect') };
    spyOn(window, 'IntersectionObserver').and.callFake(function (handler: IntersectionObserverCallback) {
      callback = handler;
      return observer as unknown as IntersectionObserver;
    });
    fixture.componentRef.setInput('selection', { range: '1D', interval: '5m' });
    open(); request('SOXL', '1D', '5m').flush({ ...payload, range: '1D', interval: '5m' });
    expect(observer.observe).toHaveBeenCalledWith(fixture.nativeElement);
    const visibility = (isIntersecting: boolean) => callback([{ isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    visibility(false);
    tick(60_000);
    http.expectNone(value => value.url === '/market_history');
    visibility(true);
    request('SOXL', '1D', '5m').flush({ ...payload, range: '1D', interval: '5m' });
    tick(60_000);
    request('SOXL', '1D', '5m').flush({ ...payload, range: '1D', interval: '5m' });
    fixture.destroy();
    expect(observer.disconnect).toHaveBeenCalled();
    tick(60_000);
    http.expectNone(value => value.url === '/market_history');
  }));

  it('treats comparison plan limits as unavailable instead of offering a useless retry', () => {
    open(); request().flush(payload);
    component.comparisonInput = 'SPY'; component.compare();
    request('SPY').flush(null, { status: 403, statusText: 'Forbidden' });
    expect(component.comparisonEntitlementError).toBeTrue();
    expect(component.comparisonError).toContain('data plan');
    expect(button('Retry comparison')).toBeUndefined();
    component.loadComparison(true); http.expectNone(value => value.url === '/market_history');
    component.load(true); request().flush(payload);
    http.expectNone('/market_history?symbol=SPY&range=1M&interval=1d');
    component.selectRange('3M'); request('SOXL', '3M').flush({ ...payload, range: '3M' });
    request('SPY', '3M').flush({ ...payload, range: '3M' });
    expect(component.comparisonEntitlementError).toBeFalse();
    expect(component.comparisonError).toBe('');
  });

  it('shows comparison cooldowns and waits before retrying a rate-limited provider', fakeAsync(() => {
    open(); request().flush(payload);
    component.comparisonInput = 'SPY'; component.compare();
    request('SPY').flush(null, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '3' } });
    expect(button('Retry comparison').disabled).toBeTrue();
    expect(button('Retry comparison').textContent).toContain('3s');
    component.loadComparison(true); http.expectNone(value => value.url === '/market_history');
    tick(3000);
    button('Retry comparison').click(); request('SPY').flush(payload);
    expect(component.comparisonRetrySeconds).toBe(0);
    expect(component.comparisonError).toBe('');
    expect(component.options.series!.some(series => series.name === 'SPY return')).toBeTrue();
  }));

  it('clears replaced comparison timers while preserving the shared provider cooldown', fakeAsync(() => {
    open(); request().flush(payload);
    component.comparisonInput = 'SPY'; component.compare();
    request('SPY').flush(null, { status: 503, statusText: 'Unavailable', headers: { 'Retry-After': '3' } });
    tick(1000);
    component.comparisonInput = 'QQQ'; component.compare();
    http.expectNone('/market_history?symbol=QQQ&range=1M&interval=1d');
    expect(component.comparisonError).toContain('QQQ');
    expect(component.comparisonRetrySeconds).toBe(2);
    component.removeComparison();
    expect(component.comparisonRetrySeconds).toBe(0);
    expect(component.comparisonError).toBe('');
    tick(2000);
    component.comparisonInput = 'QQQ'; component.compare(); request('QQQ').flush(payload);
    expect(component.options.series!.some(series => series.name === 'QQQ return')).toBeTrue();
  }));

  it('clears the comparison when a new primary symbol is the previous benchmark', () => {
    open(); request().flush(payload);
    const changed = spyOn(component.comparisonChange, 'emit');
    fixture.componentRef.setInput('comparisonTicker', 'AAPL'); fixture.detectChanges();
    request('AAPL').flush(payload);
    fixture.componentRef.setInput('symbol', 'AAPL'); fixture.detectChanges();
    expect(component.comparisonSymbol).toBe('');
    expect(component.comparisonInput).toBe('');
    expect(component.comparison).toBeNull();
    expect(changed).toHaveBeenCalledWith(null);
    expect(component.options.series!.some(series => series.name?.endsWith(' return'))).toBeFalse();
    http.expectNone(value => value.url === '/market_history');
  });

  it('updates axis currency when metadata changes without re-requesting the same history', () => {
    open(); request().flush(payload);
    fixture.componentRef.setInput('currency', 'EUR'); fixture.detectChanges();
    const axes = component.options.yAxis as import('highcharts').YAxisOptions[];
    expect(axes.find(axis => axis.id === 'price-axis')?.title?.text).toBe('EUR');
    http.expectNone(value => value.url === '/market_history');
  });

  it('groups narrow-chart study legends without removing the underlying lines or full tooltip names', () => {
    open(); request().flush(payload);
    component.studies.bb = true;
    component.studies.macd = true;
    component.render();
    const allSeries = component.options.series!;
    const middleIndex = allSeries.findIndex(series => series.name === 'Bollinger middle · 20');
    const lowerIndex = allSeries.findIndex(series => series.name === 'Bollinger lower · 20, 2σ');
    const mobile = component.options.responsive!.rules![0];
    expect(mobile.condition?.maxWidth).toBe(600);
    expect(mobile.chartOptions?.legend?.itemWidth).toBe(135);
    expect(allSeries[middleIndex].showInLegend).toBeTrue();
    expect(allSeries[lowerIndex].showInLegend).toBeTrue();
    expect(mobile.chartOptions?.series?.[middleIndex].showInLegend).toBeFalse();
    expect(mobile.chartOptions?.series?.[lowerIndex].showInLegend).toBeFalse();
    expect(allSeries.some(series => series.id === 'bollinger')).toBeTrue();
  });

  it('keeps the rendered mobile RSI axis at 0–100 when only 30 and 70 are labelled', async () => {
    open(); request().flush(payload);
    component.studies.rsi = true;
    component.render();
    const { Highcharts } = await import('../search-details/research-chart-runtime');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const chart = Highcharts.stockChart(container, { ...component.options, chart: { ...component.options.chart, width: 340 }, accessibility: { enabled: false } });
    try {
      const axis = chart.yAxis.find(value => value.options.title?.text === 'RSI 14')!;
      expect(axis.getExtremes().min).toBe(0);
      expect(axis.getExtremes().max).toBe(100);
      expect(axis.tickPositions).toEqual([30, 70]);
    } finally { chart.destroy(); container.remove(); }
  });

  it('does not retain RSI bounds when dynamic lower panes replace its axis', async () => {
    open(); request().flush(payload);
    component.studies.volume = false;
    component.studies.rsi = true;
    component.studies.macd = true;
    component.render();
    const { Highcharts } = await import('../search-details/research-chart-runtime');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const chart = Highcharts.stockChart(container, { ...component.options, chart: { ...component.options.chart, width: 340 }, accessibility: { enabled: false } });
    try {
      component.studies.rsi = false;
      component.render();
      chart.update(component.options, true, true, false);
      const axis = chart.yAxis.find(value => value.options.title?.text === 'MACD')!;
      expect(axis.options.min).not.toBe(0);
      expect(axis.options.max).not.toBe(100);
      expect(axis.options.tickPositions).toBeUndefined();
      component.studies.macd = false;
      component.studies.volume = true;
      component.render();
      chart.update(component.options, true, true, false);
      const volume = chart.yAxis.find(value => value.options.title?.text === 'Volume')!;
      expect(volume.options.max).not.toBe(100);
      expect(volume.options.tickPositions).toBeUndefined();
      expect(chart.series.find(value => value.name === 'Volume')?.yAxis).toBe(volume);
    } finally { chart.destroy(); container.remove(); }
  });
});
