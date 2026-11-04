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
    expect(element.querySelector('.performance-basis time')?.getAttribute('datetime')).toBe('2026-01-06');

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
    const baselineDate = () => element.querySelector('.performance-basis time')?.getAttribute('datetime');
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
});
