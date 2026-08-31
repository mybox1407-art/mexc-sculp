import WebSocket from 'ws';
import { OrderBook, Trade } from './types';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';

export type OrderBookHandler = (orderbook: OrderBook) => void;
export type TradeHandler = (trade: Trade) => void;

export class MexcWebSocket {
  private ws: WebSocket | null = null;
  private orderBookHandlers: Map<string, OrderBookHandler[]> = new Map();
  private tradeHandlers: Map<string, TradeHandler[]> = new Map();
  private reconnectDelay: number = 5000;
  private baseUrl: string = 'wss://contract.mexc.com/edge';
  private isConnecting: boolean = false;
  private pendingSubscriptions: Array<{ symbol: string; type: 'depth' | 'trade' }> = [];
  private orderBooks: Map<string, OrderBook> = new Map();

  constructor() {}

  public async subscribeOrderBook(symbol: string, handler: OrderBookHandler): Promise<void> {
    const upperSymbol = symbol.toUpperCase();
    if (!this.orderBookHandlers.has(upperSymbol)) {
      this.orderBookHandlers.set(upperSymbol, []);
      this.pendingSubscriptions.push({ symbol: upperSymbol, type: 'depth' });
    }
    this.orderBookHandlers.get(upperSymbol)!.push(handler);

    if (!this.orderBooks.has(upperSymbol)) {
      await this.initOrderBook(upperSymbol);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(upperSymbol, 'depth');
    } else if (!this.isConnecting) {
      await this.connect();
    }
  }

  public subscribeTrades(symbol: string, handler: TradeHandler): void {
    const upperSymbol = symbol.toUpperCase();
    if (!this.tradeHandlers.has(upperSymbol)) {
      this.tradeHandlers.set(upperSymbol, []);
      this.pendingSubscriptions.push({ symbol: upperSymbol, type: 'trade' });
    }
    this.tradeHandlers.get(upperSymbol)!.push(handler);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(upperSymbol, 'trade');
    } else if (!this.isConnecting) {
      this.connect();
    }
  }

  private async initOrderBook(symbol: string): Promise<void> {
    try {
      const url = `https://api.mexc.com/api/v1/contract/depth/${symbol}?limit=1000`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json() as {
        data?: {
          bids?: any[][];
          asks?: any[][];
          version?: number;
          cts?: number;
          timestamp?: number;
        };
        bids?: any[][];
        asks?: any[][];
        version?: number;
        cts?: number;
        timestamp?: number;
      };
      const data = json.data || json;

      const orderbook: OrderBook = {
        symbol,
        bids: (data.bids || []).map((b: any) => ({
          price: parseFloat(b[0]),
          size: parseFloat(b[1]),
        })),
        asks: (data.asks || []).map((a: any) => ({
          price: parseFloat(a[0]),
          size: parseFloat(a[1]),
        })),
        timestamp: data.cts || data.timestamp || Date.now(),
      };

      const version = Number(data.version ?? 0);
      this.orderBooks.set(symbol, orderbook);

      logger.info(
        `[ORDERBOOK_INIT] ${symbol} ` +
        `version=${version} ` +
        `bids=${orderbook.bids.length} ` +
        `asks=${orderbook.asks.length}`
      );
    } catch (err) {
      logger.error(`[ORDERBOOK_INIT_FAIL] ${symbol} ${getErrorMessage(err)}`);
    }
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) {
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.isConnecting = true;
    this.ws = new WebSocket(this.baseUrl);

    this.ws.on('open', () => {
      logger.info('WebSocket connected');
      this.isConnecting = false;
      this.subscribeAll();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        logger.error(`Error parsing WebSocket message: ${getErrorMessage(error)}`);
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error(`WebSocket error: ${error.message}`);
    });

    this.ws.on('close', () => {
      logger.info('WebSocket closed, reconnecting...');
      this.isConnecting = false;
      setTimeout(() => this.connect(), this.reconnectDelay);
    });
  }

  private subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    logger.info(`Sending ${this.pendingSubscriptions.length} pending subscriptions`);

    for (const { symbol, type } of this.pendingSubscriptions) {
      this.sendSubscription(symbol, type);
    }
  }

  private sendSubscription(symbol: string, type: 'depth' | 'trade'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const method = type === 'depth' ? 'sub.depth' : 'sub.deal';

    this.ws.send(
      JSON.stringify({
        method,
        param: { symbol },
        gzip: false,
      })
    );
  }

  private handleMessage(message: any): void {
    const channel = String(message.channel ?? '');
    const data = message.data;
    const symbol = String(message.symbol ?? '').toUpperCase();

    if (channel === 'push.depth' && data && symbol) {
      this.handleDepthUpdate(symbol, data);
      return;
    }

    if (channel === 'push.deal' && data && symbol) {
      this.handleDealUpdate(symbol, data);
    }
  }

  private handleDepthUpdate(symbol: string, data: any): void {
    const bids = this.parseLevels(data.bids);
    const asks = this.parseLevels(data.asks);

    if (bids.length === 0 || asks.length === 0) {
      logger.warn(
        `[EMPTY_ORDERBOOK:WS] ${symbol} ` +
        `bids=${bids.length} asks=${asks.length} ` +
        `version=${data.version ?? 'n/a'}`
      );
      return;
    }

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    const bestBid = bids[0];
    const bestAsk = asks[0];

    if (bestBid.price >= bestAsk.price) {
      logger.warn(
        `[INVALID_ORDERBOOK:WS] ${symbol} ` +
        `bids=${bids.length} asks=${asks.length} ` +
        `bid0=${JSON.stringify(bestBid)} ` +
        `ask0=${JSON.stringify(bestAsk)} ` +
        `version=${data.version ?? 'n/a'}`
      );
      return;
    }

    const orderbook: OrderBook = {
      symbol,
      bids: bids.slice(0, 100),
      asks: asks.slice(0, 100),
      timestamp: Number(data.cts ?? data.timestamp ?? Date.now()),
    };

    this.orderBooks.set(symbol, orderbook);

    const handlers = this.orderBookHandlers.get(symbol) || [];
    handlers.forEach(handler => handler(orderbook));
  }

  private parseLevels(levels: unknown): Array<{ price: number; size: number }> {
    if (!Array.isArray(levels)) {
      return [];
    }

    const result: Array<{ price: number; size: number }> = [];

    for (const level of levels) {
      if (!Array.isArray(level) || level.length < 2) {
        continue;
      }

      const price = Number(level[0]);
      const size = Number(level[1]);

      if (!Number.isFinite(price) || !Number.isFinite(size)) {
        continue;
      }

      if (price <= 0 || size <= 0) {
        continue;
      }

      result.push({ price, size });
    }

    return result;
  }

  private handleDealUpdate(symbol: string, data: any): void {
    const trades = Array.isArray(data) ? data : [data];

    for (const tradeData of trades) {
      const trade: Trade = {
        symbol,
        id: tradeData.id || Date.now(),
        price: parseFloat(tradeData.price || 0),
        qty: parseFloat(tradeData.vol || 0),
        quoteQty: parseFloat(tradeData.amount || 0),
        time: tradeData.ts || Date.now(),
        isBuyerMaker: tradeData.side === 'Buy',
      };

      const handlers = this.tradeHandlers.get(symbol) || [];
      handlers.forEach(h => h(trade));
    }
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnecting = false;
    }
    this.orderBooks.clear();
  }
}
