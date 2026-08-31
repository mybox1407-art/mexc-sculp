import WebSocket from 'ws';
import { OrderBook, Trade } from './types';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';

type PriceLevel = {
  price: number;
  size: number;
};

export type OrderBookHandler = (orderbook: OrderBook) => void;
export type TradeHandler = (trade: Trade) => void;

export class MexcWebSocket {
  private ws: WebSocket | null = null;
  private orderBookHandlers: Map<string, OrderBookHandler[]> = new Map();
  private tradeHandlers: Map<string, TradeHandler[]> = new Map();
  private baseUrl: string = 'wss://contract.mexc.com/edge';
  private isConnecting: boolean = false;

  // Локальный собранный стакан. Здесь применяются WS-инкременты.
  private orderBooks: Map<string, OrderBook> = new Map();

  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private manuallyDisconnected = false;

  // Желаемые подписки сохраняются после reconnect.
  private desiredSubscriptions = new Set<string>();
  private activeSubscriptions = new Set<string>();

  public async connect(): Promise<void> {
    if (this.isConnecting) {
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.manuallyDisconnected = false;
    this.isConnecting = true;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.baseUrl);
      this.ws = ws;

      const onInitialError = (error: Error) => {
        this.isConnecting = false;
        reject(error);
      };

      ws.once('open', () => {
        ws.removeListener('error', onInitialError);

        this.isConnecting = false;
        this.reconnectAttempt = 0;

        logger.info('WebSocket connected');

        this.subscribeAll();
        this.startPing();

        resolve();
      });

      ws.once('error', onInitialError);

      ws.on('message', (data, isBinary) => {
        try {
          if (isBinary) {
            logger.warn(
              {
                length: Buffer.isBuffer(data)
                  ? data.length
                  : (data as ArrayBuffer).byteLength,
              },
              'Unexpected binary WebSocket frame from MEXC'
            );
            return;
          }

          const message = JSON.parse(data.toString('utf8'));
          this.handleMessage(message);
        } catch (error) {
          logger.error(
            {
              err: getErrorMessage(error),
              isBinary,
            },
            'Failed to process MEXC WebSocket message'
          );
        }
      });

      ws.on('error', (error: Error) => {
        logger.error(`WebSocket runtime error: ${error.message}`);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonText = reason.toString('utf8');

        this.stopPing();
        this.isConnecting = false;
        this.activeSubscriptions.clear();

        if (this.ws === ws) {
          this.ws = null;
        }

        if (this.manuallyDisconnected) {
          logger.info(`WebSocket closed manually: code=${code}, reason=${reasonText}`);
          return;
        }

        logger.warn(
          `WebSocket closed: code=${code}, reason=${reasonText || 'none'}; reconnecting...`
        );

        this.scheduleReconnect();
      });
    });
  }

  public async subscribeOrderBook(
    symbol: string,
    handler: OrderBookHandler
  ): Promise<void> {
    const upperSymbol = symbol.toUpperCase();
    const key = this.subscriptionKey(upperSymbol, 'depth');

    const handlers = this.orderBookHandlers.get(upperSymbol) ?? [];
    handlers.push(handler);
    this.orderBookHandlers.set(upperSymbol, handlers);

    this.desiredSubscriptions.add(key);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeIfNeeded(upperSymbol, 'depth');
      return;
    }

    await this.connect();
  }

  public async subscribeTrades(
    symbol: string,
    handler: TradeHandler
  ): Promise<void> {
    const upperSymbol = symbol.toUpperCase();
    const key = this.subscriptionKey(upperSymbol, 'trade');

    const handlers = this.tradeHandlers.get(upperSymbol) ?? [];
    handlers.push(handler);
    this.tradeHandlers.set(upperSymbol, handlers);

    this.desiredSubscriptions.add(key);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribeIfNeeded(upperSymbol, 'trade');
      return;
    }

    await this.connect();
  }

  public disconnect(): void {
    this.manuallyDisconnected = true;

    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const ws = this.ws;
    this.ws = null;
    this.isConnecting = false;

    if (ws) {
      ws.removeAllListeners();

      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    }

    this.orderBooks.clear();
    this.activeSubscriptions.clear();
    this.desiredSubscriptions.clear();
    this.orderBookHandlers.clear();
    this.tradeHandlers.clear();
  }

  public getOrderBook(symbol: string): OrderBook | null {
    return this.orderBooks.get(symbol.toUpperCase()) ?? null;
  }

  public isStale(symbol: string, maxAgeMs = 5_000): boolean {
    const orderbook = this.getOrderBook(symbol);

    if (!orderbook) {
      return true;
    }

    return Date.now() - orderbook.timestamp > maxAgeMs;
  }

  private subscriptionKey(
    symbol: string,
    type: 'depth' | 'trade'
  ): string {
    return `${symbol}:${type}`;
  }

  private subscribeAll(): void {
    for (const key of this.desiredSubscriptions) {
      const [symbol, type] = key.split(':') as [
        string,
        'depth' | 'trade'
      ];

      this.subscribeIfNeeded(symbol, type);
    }
  }

  private subscribeIfNeeded(symbol: string, type: 'depth' | 'trade'): void {
    const key = this.subscriptionKey(symbol, type);

    if (this.activeSubscriptions.has(key)) {
      return;
    }

    if (this.sendSubscription(symbol, type)) {
      this.activeSubscriptions.add(key);
    }
  }

  private sendSubscription(
    symbol: string,
    type: 'depth' | 'trade'
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const method = type === 'depth' ? 'sub.depth' : 'sub.deal';

    try {
      this.ws.send(
        JSON.stringify({
          method,
          param: { symbol },
          gzip: false,
        })
      );

      logger.debug(`Subscribed: ${method} ${symbol}`);
      return true;
    } catch (error) {
      logger.error(
        `Failed to subscribe ${method} ${symbol}: ${getErrorMessage(error)}`
      );
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyDisconnected || this.reconnectTimer) {
      return;
    }

    const delayMs = Math.min(
      30_000,
      1_000 * 2 ** this.reconnectAttempt
    );

    const jitterMs = Math.floor(Math.random() * 500);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      this.connect().catch((error) => {
        logger.error(`WebSocket reconnect failed: ${getErrorMessage(error)}`);
        this.scheduleReconnect();
      });
    }, delayMs + jitterMs);
  }

  private startPing(): void {
    this.stopPing();

    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    const payload = message as {
      channel?: unknown;
      data?: unknown;
      symbol?: unknown;
    };

    const channel = String(payload.channel ?? '');
    const symbol = String(payload.symbol ?? '').toUpperCase();

    if (!symbol) {
      return;
    }

    if (channel === 'push.depth' && payload.data) {
      this.handleDepthUpdate(symbol, payload.data);
      return;
    }

    if (channel === 'push.deal' && payload.data) {
      this.handleDealUpdate(symbol, payload.data);
    }
  }

  private handleDepthUpdate(symbol: string, rawData: unknown): void {
    const depthKey = this.subscriptionKey(symbol, 'depth');

    if (!this.desiredSubscriptions.has(depthKey)) {
      return;
    }

    if (!rawData || typeof rawData !== 'object') {
      return;
    }

    const data = rawData as {
      bids?: unknown;
      asks?: unknown;
      version?: unknown;
      cts?: unknown;
      timestamp?: unknown;
    };

    /*
     * MEXC присылает incremental depth:
     * - может быть только одна сторона стакана;
     * - размер 0 означает удаление price level.
     *
     * Поэтому нельзя отбрасывать сообщения с пустыми bids/asks
     * и нельзя фильтровать size=0 на этапе парсинга.
     */
    const bidChanges = this.parseLevels(data.bids);
    const askChanges = this.parseLevels(data.asks);

    if (bidChanges.length === 0 && askChanges.length === 0) {
      return;
    }

    const previous = this.orderBooks.get(symbol);

    const bidMap = new Map<number, number>();
    const askMap = new Map<number, number>();

    if (previous) {
      for (const level of previous.bids) {
        bidMap.set(level.price, level.size);
      }

      for (const level of previous.asks) {
        askMap.set(level.price, level.size);
      }
    }

    this.applyLevelChanges(bidMap, bidChanges);
    this.applyLevelChanges(askMap, askChanges);

    const bids = this.toSortedLevels(bidMap, 'bid');
    const asks = this.toSortedLevels(askMap, 'ask');

    /*
     * До первого нормального snapshot одна из сторон может быть пуста.
     * Не публикуем такой стакан в Scanner, но удерживаем изменения,
     * чтобы следующий пакет мог собрать валидный two-sided book.
     */
    if (bids.length === 0 || asks.length === 0) {
      return;
    }

    /*
     * При crossed book не публикуем цену: лучше пропустить update,
     * чем передать в стратегию невалидный bid >= ask.
     */
    if (bids[0].price >= asks[0].price) {
      logger.warn(
        `[WS_CROSSED_BOOK] ${symbol} bid=${bids[0].price} ask=${asks[0].price}`
      );
      return;
    }

    const exchangeTimestamp = Number(
      data.cts ?? data.timestamp ?? Date.now()
    );

    const timestamp = Number.isFinite(exchangeTimestamp) && exchangeTimestamp > 0
      ? exchangeTimestamp
      : Date.now();

    const orderbook: OrderBook = {
      symbol,
      bids,
      asks,
      timestamp,
    };

    this.orderBooks.set(symbol, orderbook);

    const handlers = this.orderBookHandlers.get(symbol) ?? [];
    for (const handler of handlers) {
      try {
        handler(orderbook);
      } catch (error) {
        logger.error(
          `Orderbook handler failed for ${symbol}: ${getErrorMessage(error)}`
        );
      }
    }
  }

  private parseLevels(levels: unknown): PriceLevel[] {
    if (!Array.isArray(levels)) {
      return [];
    }

    const result: PriceLevel[] = [];

    for (const level of levels) {
      if (!Array.isArray(level) || level.length < 2) {
        continue;
      }

      const price = Number(level[0]);
      const size = Number(level[1]);

      /*
       * size=0 сохраняем: он нужен для удаления уровня из локального book.
       */
      if (
        !Number.isFinite(price) ||
        !Number.isFinite(size) ||
        price <= 0 ||
        size < 0
      ) {
        continue;
      }

      result.push({ price, size });
    }

    return result;
  }

  private applyLevelChanges(
    levels: Map<number, number>,
    changes: PriceLevel[]
  ): void {
    for (const level of changes) {
      if (level.size === 0) {
        levels.delete(level.price);
      } else {
        levels.set(level.price, level.size);
      }
    }
  }

  private toSortedLevels(
    levels: Map<number, number>,
    side: 'bid' | 'ask'
  ): PriceLevel[] {
    const result = Array.from(levels.entries())
      .filter(([, size]) => Number.isFinite(size) && size > 0)
      .map(([price, size]) => ({ price, size }));

    result.sort(
      side === 'bid'
        ? (a, b) => b.price - a.price
        : (a, b) => a.price - b.price
    );

    return result.slice(0, 100);
  }

  private handleDealUpdate(symbol: string, rawData: unknown): void {
    const tradeKey = this.subscriptionKey(symbol, 'trade');

    if (!this.desiredSubscriptions.has(tradeKey)) {
      return;
    }

    const items = Array.isArray(rawData) ? rawData : [rawData];
    const handlers = this.tradeHandlers.get(symbol) ?? [];

    for (const item of items) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const data = item as {
        id?: unknown;
        price?: unknown;
        vol?: unknown;
        amount?: unknown;
        ts?: unknown;
        side?: unknown;
      };

      const price = Number(data.price);
      const qty = Number(data.vol);
      const quoteQty = Number(data.amount);
      const time = Number(data.ts);

      if (
        !Number.isFinite(price) ||
        !Number.isFinite(qty) ||
        price <= 0 ||
        qty <= 0
      ) {
        continue;
      }

      const trade: Trade = {
        symbol,
        id: data.id ? String(data.id) : `${symbol}_${Date.now()}`,
        price,
        qty,
        quoteQty: Number.isFinite(quoteQty) ? quoteQty : price * qty,
        time: Number.isFinite(time) && time > 0 ? time : Date.now(),
        isBuyerMaker: String(data.side).toLowerCase() === 'sell',
      };

      for (const handler of handlers) {
        try {
          handler(trade);
        } catch (error) {
          logger.error(
            `Trade handler failed for ${symbol}: ${getErrorMessage(error)}`
          );
        }
      }
    }
  }
}
