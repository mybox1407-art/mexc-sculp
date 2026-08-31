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
  private subscribedSymbols: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private lastVersion: Map<string, number> = new Map();  // ✅

  constructor() {}

  public async subscribeOrderBook(symbol: string, handler: OrderBookHandler): Promise<void> {
    const upperSymbol = symbol.toUpperCase();
    if (!this.orderBookHandlers.has(upperSymbol)) {
      this.orderBookHandlers.set(upperSymbol, []);
    }
    this.orderBookHandlers.get(upperSymbol)!.push(handler);

    if (!this.subscribedSymbols.has(`${upperSymbol}_depth`)) {
      this.pendingSubscriptions.push({ symbol: upperSymbol, type: 'depth' });
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
    }
    this.tradeHandlers.get(upperSymbol)!.push(handler);

    if (!this.subscribedSymbols.has(`${upperSymbol}_trade`)) {
      this.pendingSubscriptions.push({ symbol: upperSymbol, type: 'trade' });
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(upperSymbol, 'trade');
    } else if (!this.isConnecting) {
      this.connect();
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
      this.startPing();
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
      this.stopPing();
      this.isConnecting = false;
      this.subscribedSymbols.clear();
      this.lastVersion.clear();
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.ws.on('pong', () => {
      logger.debug('WebSocket pong received');
    });
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

    logger.info(`Sending ${this.pendingSubscriptions.length} pending subscriptions`);

    for (const { symbol, type } of this.pendingSubscriptions) {
      this.sendSubscription(symbol, type);
      this.subscribedSymbols.add(`${symbol}_${type}`);
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
    const version = Number(data.version ?? 0);

    if (bids.length === 0 && asks.length === 0) {
      return;
    }

    // ✅ Проверка version
    const lastVer = this.lastVersion.get(symbol);
    if (lastVer && version > 0) {
      if (version <= lastVer) {
        return;
      }
      // ✅ Если большой gap — пропускаем, пусть REST обновит
      if (version > lastVer + 1000) {
        logger.warn(`[WS_GAP] ${symbol}: ${lastVer} → ${version}`);
        this.lastVersion.delete(symbol);
        this.orderBooks.delete(symbol);
        return;
      }
    }

    // ✅ Получаем кэш
    const cached = this.orderBooks.get(symbol);

    // ✅ Если нет кэша и мало уровней — пропускаем (ждем полный)
    if (!cached && (bids.length < 20 || asks.length < 20)) {
      return;
    }

    // ✅ Merge с кэшем
    let finalBids = bids;
    let finalAsks = asks;

    if (cached) {
      // ✅ Создаём map для быстрого merge
      const bidMap = new Map<number, number>();
      const askMap = new Map<number, number>();

      // Кэш в map
      for (const level of cached.bids) {
        bidMap.set(level.price, level.size);
      }
      for (const level of cached.asks) {
        askMap.set(level.price, level.size);
      }

      // ✅ Применяем дельты (replace)
      for (const level of bids) {
        if (level.size === 0) {
          bidMap.delete(level.price);
        } else {
          bidMap.set(level.price, level.size);
        }
      }
      for (const level of asks) {
        if (level.size === 0) {
          askMap.delete(level.price);
        } else {
          askMap.set(level.price, level.size);
        }
      }

      // ✅ Back to array
      finalBids = Array.from(bidMap.entries())
        .map(([price, size]) => ({ price, size }))
        .sort((a, b) => b.price - a.price)
        .slice(0, 100);

      finalAsks = Array.from(askMap.entries())
        .map(([price, size]) => ({ price, size }))
        .sort((a, b) => a.price - b.price)
        .slice(0, 100);
    } else {
      // Нет кэша — сортируем как есть
      finalBids = bids.sort((a, b) => b.price - a.price).slice(0, 100);
      finalAsks = asks.sort((a, b) => a.price - b.price).slice(0, 100);
    }

    if (finalBids.length === 0 || finalAsks.length === 0) {
      return;
    }

    const bestBid = finalBids[0];
    const bestAsk = finalAsks[0];

    if (bestBid.price >= bestAsk.price) {
      logger.debug(`[CROSSED] ${symbol}: ${bestBid.price} >= ${bestAsk.price}`);
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnecting = false;
    }
    this.orderBooks.clear();
    this.lastVersion.clear();
  }

  public isStale(symbol: string, maxAgeMs: number = 10000): boolean {
    const ver = this.lastVersion.get(symbol);
    if (ver === undefined) return true;
    // Упрощённо — просто проверяем наличие
    return false;
  }
}
