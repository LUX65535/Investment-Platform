import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, defer, firstValueFrom, from, map, shareReplay, switchMap, tap, throwError } from 'rxjs';

export interface Stock {
  ticker: string;
  name: string;
  price: number;
  change: number;
  quantity: number;
  totalCost: number;
}

export type PaperOrderSide = 'buy' | 'sell';

export interface PendingPaperOrder {
  orderId: string;
  side: PaperOrderSide;
  ticker: string;
  quantity: number;
  expiresAt: string;
}

export interface PaperOrderReceipt extends Omit<PendingPaperOrder, 'expiresAt'> {
  status: 'filled' | 'rejected';
  submittedAt: string;
  price: number | null;
  total: number | null;
  balance: number | null;
  message: string;
}

interface PaperSession {
  expiresAt: string;
}

const pendingPrefix = 'investment-paper-order:';

export class PendingOrderError extends Error {
  constructor(public readonly order: PendingPaperOrder) {
    super('This paper order is awaiting confirmation.');
  }
}

export function paperOrderUncertain(error: unknown): boolean {
  return !(error instanceof HttpErrorResponse) || error.status === 0
    || (error.status >= 200 && error.status < 300)
    || error.status === 408 || error.status === 429 || error.status >= 500;
}

export function paperOrderConfirmation(receipt: PaperOrderReceipt): string {
  const action = receipt.side === 'buy' ? 'Bought' : 'Sold';
  const shares = receipt.quantity === 1 ? 'share' : 'shares';
  const price = receipt.price === null ? '' : ` at $${receipt.price.toFixed(2)}`;
  return `${action} ${receipt.quantity} ${shares} of ${receipt.ticker}${price}. Receipt ${receipt.orderId.slice(0, 8)}.`;
}

@Injectable({
  providedIn: 'root'
})
export class PortfolioService {
  private session?: Observable<PaperSession>;
  private sessionExpiry = 0;
  private readonly volatileOrders = new Map<string, PendingPaperOrder>();

  constructor(private http: HttpClient) { }

  getStocks(): Observable<Stock[]> {
    return this.paperRequest(() => this.http.get<Stock[]>('/api/stocks')).pipe(
      map((stocksFromApi) => {
        return stocksFromApi.map((stockFromApi) => {
          return {
            ticker: stockFromApi.ticker,
            name: '',
            price: 0,
            change: 0,
            quantity: stockFromApi.quantity,
            totalCost: stockFromApi.totalCost
          };
        });
      })
    );
  }
  getBalance(): Observable<{ balance: number; initialized?: boolean }> {
    return this.paperRequest(() => this.http.get<{ balance: number; initialized?: boolean }>('/api/balance'));
  }
  initializeWallet(): Observable<{ message: string }> {
    return this.paperRequest(() => this.http.post<{ message: string }>('/api/initWallet', {}), false);
  }
  checkStock(ticker: string): Observable<{ quantity: number }> {
    return this.paperRequest(() => this.http.get<{ quantity: number }>(`/api/stocks/${encodeURIComponent(ticker)}`));
  }
  getWatchlist(): Observable<{ ticker: string }[]> {
    return this.paperRequest(() => this.http.get<{ ticker: string }[]>('/api/watchlist'));
  }
  checkWatchlist(ticker: string): Observable<boolean> {
    return this.paperRequest(() => this.http.get<boolean>(`/api/watchlist/check/${encodeURIComponent(ticker)}`));
  }
  addWatchlist(ticker: string): Observable<unknown> {
    return this.paperRequest(() => this.http.post('/api/watchlist', { ticker }), false);
  }
  removeWatchlist(ticker: string): Observable<unknown> {
    return this.paperRequest(() => this.http.delete(`/api/watchlist/${encodeURIComponent(ticker)}`), false);
  }
  getReceipts(): Observable<PaperOrderReceipt[]> {
    return this.paperRequest(() => this.http.get<PaperOrderReceipt[]>('/api/orders')).pipe(
      tap(receipts => receipts.forEach(receipt => this.clearPending(receipt))),
    );
  }

  getPendingOrder(side: PaperOrderSide, ticker: string): PendingPaperOrder | undefined {
    return this.getPendingOrders().find(order => order.side === side && order.ticker === ticker);
  }

  getPendingOrders(): PendingPaperOrder[] {
    let keys: string[];
    try {
      keys = Object.keys(localStorage).filter(key => key.startsWith(pendingPrefix));
    } catch {
      keys = [];
    }
    return [...new Set([...keys, ...this.volatileOrders.keys()])]
      .map(key => this.readPending(key))
      .filter((order): order is PendingPaperOrder => Boolean(order));
  }

  placeOrder(side: PaperOrderSide, ticker: string, quantity: number): Observable<PaperOrderReceipt> {
    return this.submitOrder(side, ticker, quantity);
  }

  retryOrder(order: PendingPaperOrder): Observable<PaperOrderReceipt> {
    return this.submitOrder(order.side, order.ticker, order.quantity, order);
  }

  private submitOrder(
    side: PaperOrderSide, ticker: string, quantity: number, retry?: PendingPaperOrder,
  ): Observable<PaperOrderReceipt> {
    return defer(() => from(this.withBrowserLock(`${pendingPrefix}${side}:${ticker}`, async () => {
      const pending = retry ?? this.getPendingOrder(side, ticker);
      let session: PaperSession;
      try {
        session = await firstValueFrom(this.ensureSession());
      } catch (error) {
        if (pending && paperOrderUncertain(error)) throw new PendingOrderError(pending);
        throw error;
      }
      if (pending && pending.expiresAt !== session.expiresAt) {
        this.clearPending(pending);
        throw this.orderConflict('This order belonged to an earlier paper session.');
      }
      if (pending && pending.quantity !== quantity) {
        throw this.orderConflict('Retry the pending order before changing the number of shares.');
      }
      const order = pending ?? { orderId: crypto.randomUUID(), side, ticker, quantity, expiresAt: session.expiresAt };
      this.storePending(order);
      try {
        const result = await firstValueFrom(this.paperRequest(() => this.http.post<{ receipt: PaperOrderReceipt }>(
          `/api/${side}`, { ticker, quantity, orderId: order.orderId }
        ), false));
        if (result?.receipt?.orderId !== order.orderId || result.receipt.status !== 'filled') {
          throw new Error('The order response did not contain a matching receipt.');
        }
        this.clearPending(order);
        return result.receipt;
      } catch (error) {
        if (paperOrderUncertain(error)) throw new PendingOrderError(order);
        this.clearPending(order);
        throw error;
      }
    })));
  }

  private orderConflict(message: string): HttpErrorResponse {
    return new HttpErrorResponse({ status: 409, error: { message } });
  }

  private pendingKey(order: Pick<PendingPaperOrder, 'orderId'>): string {
    return `${pendingPrefix}${order.orderId}`;
  }

  private readPending(key: string): PendingPaperOrder | undefined {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const order = JSON.parse(raw) as PendingPaperOrder;
        if (order?.orderId && Date.parse(order.expiresAt) > Date.now()) return order;
        localStorage.removeItem(key);
      }
    } catch {
      // A browser with storage blocked can still retry while this workspace is open.
    }
    return this.volatileOrders.get(key);
  }

  private storePending(order: PendingPaperOrder): void {
    const key = this.pendingKey(order);
    try {
      localStorage.setItem(key, JSON.stringify(order));
      this.volatileOrders.delete(key);
    } catch {
      this.volatileOrders.set(key, order);
    }
  }

  private clearPending(order: Pick<PendingPaperOrder, 'orderId'>): void {
    const key = this.pendingKey(order);
    this.volatileOrders.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      // Volatile storage was already cleared.
    }
  }

  private withBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request(name, action) : action();
  }

  private ensureSession(): Observable<PaperSession> {
    if (this.sessionExpiry && this.sessionExpiry <= Date.now()) this.clearSession();
    if (this.session) return this.session;
    const request = defer(() => from(this.withBrowserLock(
      'investment-paper-session',
      () => firstValueFrom(this.http.get<PaperSession>('/api/paper/session')),
    ))).pipe(
      tap(session => this.sessionExpiry = Date.parse(session.expiresAt)),
      catchError(error => {
        if (this.session === request) this.clearSession();
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.session = request;
    return request;
  }

  private clearSession(): void {
    this.session = undefined;
    this.sessionExpiry = 0;
  }

  private paperRequest<T>(send: () => Observable<T>, retryRead = true): Observable<T> {
    return defer(() => {
      const session = this.ensureSession();
      return session.pipe(
        switchMap(send),
        catchError((error: HttpErrorResponse) => {
          if (error.status !== 428 || error.error?.code !== 'PAPER_SESSION_REQUIRED') {
            return throwError(() => error);
          }
          if (this.session === session) this.clearSession();
          return retryRead ? this.paperRequest(send, false) : throwError(() => error);
        }),
      );
    });
  }
}
