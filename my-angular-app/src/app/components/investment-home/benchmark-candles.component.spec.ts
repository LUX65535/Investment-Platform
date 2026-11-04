import { TestBed } from '@angular/core/testing';
import { MarketBar } from '../../services/market-history.service';
import { BenchmarkCandlesComponent } from './benchmark-candles.component';

function bar(date: string, fields: Partial<MarketBar> = {}): MarketBar {
  return { t: Date.parse(date + 'T05:00:00Z'), o: 510, h: 518, l: 508, c: 513, v: 12345678.25, n: 42, vw: 512, ...fields };
}

describe('BenchmarkCandlesComponent', () => {
  it('plots reported candles and volume, changes range locally, and follows keyboard session selection', () => {
    const fixture = TestBed.createComponent(BenchmarkCandlesComponent);
    fixture.componentRef.setInput('bars', [
      bar('2024-01-03'),
      bar('2024-02-06', { c: 511 }),
      bar('2024-02-07', { o: 516, c: 509 }),
      bar('2024-02-28', { o: 508, c: 515 }),
    ]);
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    const chart = page.querySelector<HTMLElement>('[role="slider"]')!;
    const date = () => page.querySelector('time')?.getAttribute('datetime');
    expect(page.querySelectorAll('.candlestick').length).toBe(3);
    expect(page.querySelectorAll('.volume-mark').length).toBe(3);
    expect(page.querySelectorAll('.candlestick.down').length).toBe(1);
    expect(date()).toBe('2024-02-28');
    expect(chart.getAttribute('aria-valuetext')).toContain('Close $515.00');
    expect(chart.getAttribute('aria-valuetext')).toContain('Volume 12,345,678.25 shares');
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    fixture.detectChanges();
    expect(date()).toBe('2024-02-07');
    expect(chart.getAttribute('aria-valuetext')).toContain('Open $516.00');
    page.querySelector<HTMLButtonElement>('[aria-label="3 months"]')!.click();
    fixture.detectChanges();
    expect(page.querySelectorAll('.candlestick').length).toBe(4);
    expect(date()).toBe('2024-02-07');
    chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    fixture.detectChanges();
    expect(date()).toBe('2024-01-03');
    page.querySelector<HTMLButtonElement>('[aria-label="1 month"]')!.click();
    fixture.detectChanges();
    expect(date()).toBe('2024-02-28');
  });

  it('marks close-only observations, omits unavailable volume, and rejects future or invalid closes', () => {
    const fixture = TestBed.createComponent(BenchmarkCandlesComponent);
    fixture.componentRef.setInput('bars', [
      bar('2024-01-02', { h: 505, l: -5, v: NaN }),
      bar('2024-01-03', { c: 0 }),
      bar('2099-01-01'),
    ]);
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    const chart = page.querySelector<HTMLElement>('[role="img"]')!;
    expect(page.querySelectorAll('.candlestick').length).toBe(0);
    expect(page.querySelectorAll('.volume-mark').length).toBe(0);
    expect(page.querySelectorAll('.close-only-mark').length).toBe(1);
    expect(chart.getAttribute('aria-label')).toContain('High unavailable');
    expect(chart.getAttribute('aria-label')).toContain('Close $513.00');
    expect(chart.getAttribute('aria-label')).toContain('Volume unavailable');
    expect(page.textContent).toContain('Limited history for this range');
  });
});
