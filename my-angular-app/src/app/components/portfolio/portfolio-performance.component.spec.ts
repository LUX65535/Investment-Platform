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
});
