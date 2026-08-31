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
  private orderBooks: Map<string, OrderBook> = new Map();
  private subscribedSymbols: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private lastVersion: Map<string, number> = new Map();

  // Новая логика подписок
  private desiredSubscriptions = new Set<string>();
  private activeSubscriptions = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {}

  public async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.baseUrl);

      this.ws.once('open', () => {
        logger.info('WebSocket connected');
        this.isConnecting = false;
        this.reconnectAttempt = 0;
        this.subscribeAll();
        this.startPing();
        resolve();
      });

      this.ws.once('error', (err) => {
        logger.error(`WebSocket error on connect: ${getErrorMessage(err)}`);
        this.isConnecting = false;
        reject(err);
      });

      this.ws.on('message', (data, isBinary) => {
        try {
          if (isBinary) {
            logger.warn(
              { length: Buffer.isBuffer(data) ? data.length : (data as ArrayBuffer).byteLength },
              'Unexpected binary WS frame from MEXC'
            );
            return;
          }

          const text = data.toString('utf8');
          const message = JSON.parse(text);
          this.handleMessage(message);
        } catch (error) {
          logger.error(
            {
              err: getErrorMessage(error),
              isBinary,
              length: Buffer.isBuffer(data) ? data.length : undefined,
            },
            'Failed to process MEXC WS frame'
          );
        }
      });

      this.ws.on('error', (error: Error) => {
        logger.error(`WebSocket runtime error: ${error.message}`);
      });

      this.ws.on('close', () => {
        logger.info('WebSocket closed, reconnecting...');
        this.handleReconnect();
      });

      this.ws.on('pong', () => {
        logger.debug('WebSocket pong received');
      });
    });
  }

  private handleReconnect(): void {
    this.stopPing();
    this.isConnecting = false;
    this.activeSubscriptions.clear();
    this.lastVersion.clear();
    // desiredSubscriptions НЕ чистим

    if (this.reconnectTimer) {
      return;
    }

    const baseMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
    const jitterMs = Math.floor(Math.random() * 500);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        logger.error(`Reconnect failed: ${getErrorMessage(err)}`);
      });
    }, baseMs + jitterMs);
  }

  private startPing(): void {
    this.stopPing();
    
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        logger.debug('WebSocket ping sent');
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    logger.info(`Sending ${this.desiredSubscriptions.size} desired subscriptions`);

    for (const key of this.desiredSubscriptions) {
      if (this.activeSubscriptions.has(key)) {
        continue;
      }

      const parts = key.split('_');
      const symbol = parts[0];
      const type = parts[1] as 'depth' | 'trade';

      this.sendSubscription(symbol, type);
      this.activeSubscriptions.add(key);
    }
  }

  public async subscribeOrderBook(symbol: string, handler: OrderBookHandler): Promise<void> {
    const upperSymbol = symbol.toUpperCase();
    const key = `${upperSymbol}_depth`;

    if (!this.orderBookHandlers.has(upperSymbol)) {
      this.orderBookHandlers.set(upperSymbol, []);
    }
    this.orderBookHandlers.get(upperSymbol)!.push(handler);

    if (this.desiredSubscriptions.has(key)) {
      return;
    }

    this.desiredSubscriptions.add(key);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(upperSymbol, 'depth');
      this.activeSubscriptions.add(key);
    } else if (!this.isConnecting) {
      this.connect().catch((err) => {
        logger.error(`Failed to connect in subscribeOrderBook: ${getErrorMessage(err)}`);
      });
    }
  }

  public subscribeTrades(symbol: string, handler: TradeHandler): void {
    const upperSymbol = symbol.toUpperCase();
    const key = `${upperSymbol}_trade`;

    if (!this.tradeHandlers.has(upperSymbol)) {
      this.tradeHandlers.set(upperSymbol, []);
    }
    this.tradeHandlers.get(upperSymbol)!.push(handler);

    if (this.desiredSubscriptions.has(key)) {
      return;
    }

    this.desiredSubscriptions.add(key);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(upperSymbol, 'trade');
      this.activeSubscriptions.add(key);
    } else if (!this.isConnecting) {
      this.connect().catch((err) => {
        logger.error(`Failed to connect in subscribeTrades: ${getErrorMessage(err)}`);
      });
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

    logger.debug(`Sent subscription: ${method} ${symbol}`);
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
    const version = Number(data.version ?? 0);

    if (bids.length === 0 && asks.length === 0) {
      return;
    }

    const lastVer = this.lastVersion.get(symbol);
    if (lastVer && version > 0) {
      if (version <= lastVer) {
        return;
      }
      if (version > lastVer + 1000) {
        logger.warn(`[WS_GAP] ${symbol}: ${lastVer} → ${version}`);
        this.lastVersion.delete(symbol);
        this.orderBooks.delete(symbol);
        return;
      }
    }

    const cached = this.orderBooks.get(symbol);

    if (!cached && (bids.length < 20 || asks.length < 20)) {
      return;
    }

    let finalBids = bids;
    let finalAsks = asks;

    if (cached) {
      const newBids = [...bids];
      const newAsks = [...asks];

      for (const level of cached.bids) {
        if (!newBids.find(b => b.price === level.price)) {
          newBids.push(level);
        }
      }
      for (const level of cached.asks) {
        if (!newAsks.find(a => a.price === level.price)) {
          newAsks.push(level);
        }
      }

      finalBids = newBids
        .sort((a, b) => b.price - a.price)
        .slice(0, 100);

      finalAsks = newAsks
        .sort((a, b) => a.price - b.price)
        .slice(0, 100);
    } else {
      finalBids = bids.sort((a, b) => b.price - a.price).slice(0, 100);
      finalAsks = asks.sort((a, b) => a.price - b.price).slice(0, 100);
    }

    if (finalBids.length === 0 || finalAsks.length === 0) {
      return;
    }

    const bestBid = finalBids[0];
    const bestAsk = finalAsks[0];

    if (bestBid.price >= bestAsk.price) {
      return;
    }

    const orderbook: OrderBook = {
      symbol,
      bids: finalBids,
      asks: finalAsks,
      timestamp: Number(data.cts ?? data.timestamp ?? Date.now()),
    };

    this.orderBooks.set(symbol, orderbook);

    if (version > 0) {
      this.lastVersion.set(symbol, version);
    }

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
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    this.orderBooks.clear();
    this.lastVersion.clear();
    this.activeSubscriptions.clear();
    this.desiredSubscriptions.clear();
  }

  public isStale(symbol: string): boolean {
    const ver = this.lastVersion.get(symbol);
    return ver === undefined;
  }
}
