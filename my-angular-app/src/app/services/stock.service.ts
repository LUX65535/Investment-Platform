import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class StockService {
  private lastSearchSubject = new BehaviorSubject<string | null>(null);
  lastSearch$ = this.lastSearchSubject.asObservable();

  setLastSearch(ticker: string) {
    this.lastSearchSubject.next(ticker);
  }

  clearLastSearch() {
    this.lastSearchSubject.next(null);
  }
}
