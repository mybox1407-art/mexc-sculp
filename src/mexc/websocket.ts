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
  private lastVersions: Map<string, number> = new Map();
  private invalidVersionCount: Map<string, number> = new Map();

  constructor() {}

  public async subscribeOrderBook(symbol: string, handler: OrderBookHandler): Promise<void> {
    const upperSymbol = symbol.toUpperCase();
    if (!this.orderBookHandlers.has(upperSymbol)) {
      this.orderBookHandlers.set(upperSymbol, []);
      this.pendingSubscriptions.push({ symbol: upperSymbol, type: 'depth' });
      // Инициализируем счётчики
      this.invalidVersionCount.set(upperSymbol, 0);
    }
    this.orderBookHandlers.get(upperSymbol)!.push(handler);

    // Если стакан ещё не инициализирован — загружаем снапшот
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
      const json = await res.json();
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
      this.lastVersions.set(symbol, version);
      this.invalidVersionCount.set(symbol, 0);

      logger.info(`[ORDERBOOK_INIT] ${symbol} version=${version} bids=${orderbook.bids.length} asks=${orderbook.asks.length}`);
    } catch (err) {
      logger.error(`[ORDERBOOK_INIT_FAIL] ${symbol} ${getErrorMessage(err)}`);
      // Не выбрасываем, чтобы не ломать подписку; просто не будет стакана до первого успешного снапшота
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
    const symbol = String(message.symbol ?? '');

    if (channel === 'push.depth' && data && symbol) {
      this.handleDepthUpdate(symbol, data);
    } else if (channel === 'push.deal' && data && symbol) {
      this.handleDealUpdate(symbol, data);
    }
  }

  private handleDepthUpdate(symbol: string, data: any): void {
    const version = Number(data.version ?? 0);
    const lastVersion = this.lastVersions.get(symbol);

    // Если стакана ещё нет — игнорируем, пока не будет инициализирован через REST
    const existing = this.orderBooks.get(symbol);
    if (!existing) {
      return;
    }

    // Пропускаем старые версии
    if (lastVersion !== undefined && version <= lastVersion) {
      return;
    }

    // Проверка непрерывности версии
    if (lastVersion !== undefined && version !== lastVersion + 1) {
      const invalidCount = (this.invalidVersionCount.get(symbol) || 0) + 1;
      this.invalidVersionCount.set(symbol, invalidCount);

      logger.warn(
        `[VERSION_GAP:WS] ${symbol} lastVersion=${lastVersion} newVersion=${version} gap=${version - lastVersion} cnt=${invalidCount}`
      );

      // При серьёзном разрыве — сброс и повторная инициализация
      if (invalidCount > 5) {
        logger.warn(`[ORDERBOOK_RESYNC] ${symbol} – clearing local state due to version gaps`);
        this.orderBooks.delete(symbol);
        this.lastVersions.delete(symbol);
        this.invalidVersionCount.set(symbol, 0);
        // Можно здесь вызвать this.initOrderBook(symbol) и/или переподписку
      }
      return;
    }

    // Применяем обновление
    const bidsUpdate = (data.bids || []).map((b: any) => ({
      price: parseFloat(b[0]),
      size: parseFloat(b[1]),
    }));

    const asksUpdate = (data.asks || []).map((a: any) => ({
      price: parseFloat(a[0]),
      size: parseFloat(a[1]),
    }));

    for (const bid of bidsUpdate) {
      const idx = existing.bids.findIndex(b => b.price === bid.price);
      if (idx >= 0) {
        if (bid.size === 0) {
          existing.bids.splice(idx, 1);
        } else {
          existing.bids[idx] = bid;
        }
      } else if (bid.size > 0) {
        existing.bids.push(bid);
      }
    }

    for (const ask of asksUpdate) {
      const idx = existing.asks.findIndex(a => a.price === ask.price);
      if (idx >= 0) {
        if (ask.size === 0) {
          existing.asks.splice(idx, 1);
        } else {
          existing.asks[idx] = ask;
        }
      } else if (ask.size > 0) {
        existing.asks.push(ask);
      }
    }

    existing.bids.sort((a, b) => b.price - a.price);
    existing.asks.sort((a, b) => a.price - b.price);
    existing.bids = existing.bids.slice(0, 100);
    existing.asks = existing.asks.slice(0, 100);

    existing.timestamp = data.cts || data.timestamp || Date.now();

    // Проверка на «перевёрнутый» стакан
    if (
      existing.bids.length === 0 ||
      existing.asks.length === 0 ||
      existing.bids[0].price >= existing.asks[0].price
    ) {
      logger.warn(
        `[INVALID_ORDERBOOK:WS] ${symbol} ` +
        `bids=${existing.bids.length} asks=${existing.asks.length} ` +
        `bid0=${JSON.stringify(existing.bids[0] ?? null)} ` +
        `ask0=${JSON.stringify(existing.asks[0] ?? null)} ` +
        `version=${version}`
      );

      // Сброс при повторных ошибках
      const invalidCount = (this.invalidVersionCount.get(symbol) || 0) + 1;
      this.invalidVersionCount.set(symbol, invalidCount);

      if (invalidCount > 3) {
        logger.warn(`[ORDERBOOK_RESYNC:INVALID] ${symbol} – clearing local state`);
        this.orderBooks.delete(symbol);
        this.lastVersions.delete(symbol);
        this.invalidVersionCount.set(symbol, 0);
      }
      return; // не отдаём сломанный стакан хендлерам
    }

    // Всё ок — обновляем версию и счётчик ошибок
    this.lastVersions.set(symbol, version);
    this.invalidVersionCount.set(symbol, 0);

    this.orderBooks.set(symbol, existing);

    const handlers = this.orderBookHandlers.get(symbol) || [];
    handlers.forEach(h => h(existing));
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
    this.lastVersions.clear();
    this.invalidVersionCount.clear();
  }
}
