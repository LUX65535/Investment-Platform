import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PortfolioPerformanceComponent } from './portfolio-performance.component';

describe('PortfolioPerformanceComponent', () => {
  let fixture: ComponentFixture<PortfolioPerformanceComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PortfolioPerformanceComponent] }).compileComponents();
    fixture = TestBed.createComponent(PortfolioPerformanceComponent);
  });

  it('keeps early dollar valuations available before the first shared SPY close', () => {
    fixture.componentRef.setInput('points', [
      { date: '2026-01-05', nav: 25000, spyClose: null },
      { date: '2026-01-06', nav: 25100, spyClose: 100 },
      { date: '2026-01-07', nav: 25250, spyClose: 105 },
    ]);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const range = element.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(range.max).toBe('1');
    const [compare, dollars] = Array.from(element.querySelectorAll<HTMLButtonElement>('.performance-modes button'));
    expect(compare.getAttribute('aria-pressed')).toBe('true');
    expect(element.querySelector('.review-window time')?.getAttribute('datetime')).toBe('2026-01-06');

    dollars.click();
    fixture.detectChanges();
    expect(dollars.getAttribute('aria-pressed')).toBe('true');
    expect(range.max).toBe('2');

    range.value = '0';
    range.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(range.getAttribute('aria-valuetext')).toBe('Jan 5, 2026, account value $25,000.00');

    compare.click();
    fixture.detectChanges();
    expect(range.getAttribute('aria-valuetext')).toBe('Jan 6, 2026, account value $25,100.00, portfolio return 0%, SPY return 0%');
  });

  it('uses dollar values when there is only one shared closing date', () => {
    fixture.componentRef.setInput('points', [
      { date: '2026-01-05', nav: 25000, spyClose: null },
      { date: '2026-01-06', nav: 25100, spyClose: 100 },
    ]);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.performance-modes')).toBeNull();
    expect(element.querySelector('.performance-basis')?.textContent).toContain('needs two shared closing dates');
    expect(element.querySelector('svg')?.getAttribute('aria-label')).toBe('Portfolio closing value in U.S. dollars');
  });

  it('keeps keyboard focus in the history panel when retry replaces its button', () => {
    fixture.componentRef.setInput('failed', true);
    fixture.componentInstance.retry.subscribe(() => fixture.componentRef.setInput('loading', true));
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const retry = element.querySelector('button')!;
    retry.focus();
    expect(document.activeElement).toBe(retry);

    retry.click();
    fixture.detectChanges();
    expect(element.contains(retry)).toBeFalse();
    expect(document.activeElement).toBe(element.querySelector('h2'));
  });

  it('breaks the chart line and fill when a closing valuation is missing', () => {
    fixture.componentRef.setInput('points', [
      { date: '2026-01-05', nav: 25000, spyClose: 99 },
      { date: '2026-01-06', nav: 25100, spyClose: 100 },
      { date: '2026-01-07', nav: null, spyClose: 105 },
      { date: '2026-01-08', nav: 25250, spyClose: 104 },
      { date: '2026-01-09', nav: 25400, spyClose: 106 },
    ]);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const line = element.querySelector('.series-line')?.getAttribute('d');
    const area = element.querySelector('.valuation-area')?.getAttribute('d');
    expect(line?.match(/M/g)?.length).toBe(2);
    expect(area?.match(/Z/g)?.length).toBe(2);
    expect(element.querySelectorAll('.gap-tick').length).toBe(1);
  });

  it('uses inclusive calendar ranges and rebases to the first shared close inside each window', () => {
    fixture.componentRef.setInput('points', [
      { date: '2026-01-06', nav: 100, spyClose: 480 },
      { date: '2026-01-08', nav: 102, spyClose: 490 },
      { date: '2026-01-30', nav: 103, spyClose: 495 },
      { date: '2026-02-02', nav: 103, spyClose: null },
      { date: '2026-02-03', nav: 104, spyClose: 500 },
      { date: '2026-02-06', nav: 107, spyClose: 510 },
    ]);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const [week, twoWeeks, month] = Array.from(element.querySelectorAll<HTMLButtonElement>('.performance-ranges button'));
    const baselineDate = () => element.querySelector('.review-window time')?.getAttribute('datetime');
    expect(month.getAttribute('aria-pressed')).toBe('true');
    expect(baselineDate()).toBe('2026-01-08');
    expect(Array.from(element.querySelectorAll('.chart-dates time')).some(tick => tick.getAttribute('datetime') === '2026-01-30')).toBeTrue();

    twoWeeks.click();
    fixture.detectChanges();
    expect(baselineDate()).toBe('2026-01-30');

    week.click();
    fixture.detectChanges();
    expect(week.getAttribute('aria-pressed')).toBe('true');
    expect(baselineDate()).toBe('2026-02-03');
    expect(element.querySelector('.chart-relative dd')?.textContent?.trim()).toBe('+0.88 pp');

    element.querySelector<HTMLButtonElement>('[aria-label="Account value"]')!.click();
    fixture.detectChanges();
    expect(element.querySelector('.chart-dates time')?.getAttribute('datetime')).toBe('2026-02-02');
    expect(element.querySelector('.chart-metrics--value div:last-child dd')?.textContent?.trim()).toBe('+$4.00');
  });

  it('keeps the date controls available when a shorter window has no priced portfolio close', () => {
    fixture.componentRef.setInput('points', [
      { date: '2026-01-21', nav: 25000, spyClose: 100 },
      { date: '2026-02-04', nav: null, spyClose: 101 },
    ]);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const [week, , month] = Array.from(element.querySelectorAll<HTMLButtonElement>('.performance-ranges button'));
    week.click();
    fixture.detectChanges();
    expect(element.querySelector('.performance-state')?.textContent).toContain('Choose a longer range');

    month.click();
    fixture.detectChanges();
    expect(element.querySelector('svg')?.getAttribute('aria-label')).toBe('Portfolio closing value in U.S. dollars');
  });

  it('uses common closing endpoints for the narrative and position contributions', () => {
    fixture.componentRef.setInput('points', [
      { date: '2026-01-05', nav: 10000, spyClose: 100 },
      { date: '2026-01-06', nav: 10120, spyClose: 100.5 },
      { date: '2026-01-07', nav: 10400, spyClose: 101 },
      { date: '2026-01-08', nav: 10420, spyClose: null },
    ]);
    fixture.componentRef.setInput('attribution', [
      { date: '2026-01-05', contributions: [{ ticker: 'MSFT', cents: 2500 }] },
      { date: '2026-01-07', contributions: [{ ticker: 'AAPL', cents: 50000 }, { ticker: 'MSFT', cents: -7500 }] },
    ]);
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const summary = () => element.querySelector('.review-summary')?.textContent;
    expect(summary()).toContain('moved up $400.00 and finished 3 pp ahead of SPY');
    expect(Array.from(element.querySelectorAll<HTMLTimeElement>('.review-window time')).map(time => time.dateTime))
      .toEqual(['2026-01-05', '2026-01-07']);
    expect(element.querySelector<HTMLTimeElement>('.chart-readout time')?.dateTime).toBe('2026-01-07');
    expect(Array.from(element.querySelectorAll('.attribution-list strong')).map(amount => amount.textContent))
      .toEqual(['+$500.00', '-$100.00']);
    expect(element.querySelector('.attribution-total strong')?.textContent).toBe('+$400.00');
    const contributor = element.querySelector<HTMLButtonElement>('.mobile-contributor')!;
    expect(contributor.querySelector('strong')?.textContent).toBe('AAPL +$500.00');
    contributor.click();
    expect(document.activeElement).toBe(element.querySelector('.attribution'));

    element.querySelector<HTMLButtonElement>('[aria-label="Account value"]')!.click();
    fixture.detectChanges();
    expect(summary()).toContain('moved up $420.00');
    expect(element.querySelector('.attribution-state')?.textContent).toContain('unavailable for these closes');
    expect(element.querySelector('.attribution-total')).toBeNull();
    expect(element.querySelector('.mobile-contributor')).toBeNull();
  });
});
