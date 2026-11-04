import { TestBed } from '@angular/core/testing';
import { PortfolioComponent } from './portfolio.component';

describe('Portfolio position ledger', () => {
  let component: PortfolioComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    component = TestBed.runInInjectionContext(() => new PortfolioComponent(null!, null!, null!));
    component.holdingsCurrent = true;
    component.cashBalance = 500;
    component.portfolio = [
      { ticker: 'BETA', name: '', quantity: 2, totalCost: 80, price: 100, change: -1 },
      { ticker: 'ALFA', name: '', quantity: 4, totalCost: 160, price: 50, change: 1 },
      { ticker: 'MISSING', name: '', quantity: 8, totalCost: 80, price: null, change: null },
    ];
  });

  it('sorts valid values in both directions and keeps unpriced positions last', () => {
    const tickers = () => component.sortedPortfolio.map(position => position.ticker);
    expect(tickers()).toEqual(['ALFA', 'BETA', 'MISSING']);
    expect(component.sortState('marketValue')).toBe('descending');

    component.sortPositions('price');
    expect(tickers()).toEqual(['BETA', 'ALFA', 'MISSING']);
    component.sortPositions('price');
    expect(tickers()).toEqual(['ALFA', 'BETA', 'MISSING']);
    expect(component.sortState('price')).toBe('ascending');
    expect(component.sortState('marketValue')).toBeNull();
  });

  it('uses full account equity for weights and cost basis for returns', () => {
    const holding = component.portfolio[0];
    expect(component.holdingWeight(holding)).toBeNull();
    expect(component.holdingReturn(holding)).toBeCloseTo(1.5, 8);

    component.portfolio = component.portfolio.slice(0, 2);
    expect(component.holdingWeight(holding)).toBeCloseTo(200 / 900, 8);
  });
});
