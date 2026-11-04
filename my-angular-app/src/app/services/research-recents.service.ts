import { Injectable, signal } from '@angular/core';

const storageKey = 'investment-recent-symbols';
const maxRecentSymbols = 8;
const symbolPattern = /^[A-Z0-9][A-Z0-9.:-]{0,24}$/;

@Injectable({ providedIn: 'root' })
export class ResearchRecentsService {
  private readonly recent = signal(this.read());
  readonly symbols = this.recent.asReadonly();

  remember(symbol: string): void {
    if (!symbolPattern.test(symbol)) return;
    const symbols = [symbol, ...this.recent().filter(item => item !== symbol)].slice(0, maxRecentSymbols);
    this.recent.set(symbols);
    try {
      localStorage.setItem(storageKey, JSON.stringify(symbols));
    } catch {
      // The in-memory list is still available if storage is blocked.
    }
  }

  private read(): string[] {
    try {
      const items: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(items)) return [];
      return [...new Set(items.filter((item): item is string => typeof item === 'string' && symbolPattern.test(item)))]
        .slice(0, maxRecentSymbols);
    } catch {
      return [];
    }
  }
}
