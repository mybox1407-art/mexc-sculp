import WebSocket from 'ws';
import { OrderBook, Trade } from './types';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';
import { MexcProtoDecoder } from './MexcProtoDecoder';

export type OrderBookHandler = (orderbook: OrderBook) => void;
export type TradeHandler = (trade: Trade) => void;

export class MexcWebSocket {
  private ws: WebSocket | null = null;
  private orderBookHandlers: Map<string, OrderBookHandler[]> = new Map();
  private tradeHandlers: Map<string, TradeHandler[]> = new Map();
  private reconnectDelay: number = 5000;
  private baseUrl: string = 'wss://wbs.mexc.com/ws';
  private isConnecting: boolean = false;
  private pendingSubscriptions: Array<{ symbol: string; type: 'depth' | 'trade' }> = [];
  private decoder?: MexcProtoDecoder;

  constructor() {}

  public async subscribeOrderBook(symbol: string, handler: OrderBookHandler): Promise<void> {
    if (!this.orderBookHandlers.has(symbol)) {
      this.orderBookHandlers.set(symbol, []);
      this.pendingSubscriptions.push({ symbol, type: 'depth' });
    }
    this.orderBookHandlers.get(symbol)!.push(handler);
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(symbol, 'depth');
    } else if (!this.isConnecting) {
      await this.connect();
    }
  }

  public subscribeTrades(symbol: string, handler: TradeHandler): void {
    if (!this.tradeHandlers.has(symbol)) {
      this.tradeHandlers.set(symbol, []);
      this.pendingSubscriptions.push({ symbol, type: 'trade' });
    }
    this.tradeHandlers.get(symbol)!.push(handler);
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(symbol, 'trade');
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
    
    // Инициализируем декодер
    if (!this.decoder) {
      try {
        this.decoder = await MexcProtoDecoder.create();
        logger.info('MEXC ProtoDecoder initialized');
      } catch (error) {
        logger.error(`Failed to initialize ProtoDecoder: ${getErrorMessage(error)}`);
        this.isConnecting = false;
        return;
      }
    }
    
    this.ws = new WebSocket(this.baseUrl);

    this.ws.on('open', () => {
      logger.info('WebSocket connected');
      this.isConnecting = false;
      this.subscribeAll();
    });

    this.ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
      if (!isBinary) {
        // JSON сообщения (trade, ping, error responses)
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          logger.error(`Error parsing WebSocket message: ${getErrorMessage(error)}`);
        }
      } else {
        // Бинарные protobuf сообщения (depth)
        this.handleBinaryMessage(data as WebSocket.RawData);
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
    
    // Группируем подписки по типу
    const depthParams = this.pendingSubscriptions
      .filter(s => s.type === 'depth')
      .map(s => `spot@public.limit.depth.v3.api.pb@${s.symbol.toUpperCase()}@5`);
    
    const tradeParams = this.pendingSubscriptions
      .filter(s => s.type === 'trade')
      .map(s => `${s.symbol.toLowerCase()}@trade`);
    
    // Отправляем depth подписки
    if (depthParams.length > 0) {
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: depthParams,
      }));
      logger.info(`Subscribed to ${depthParams.length} depth streams: ${depthParams.slice(0, 3).join(', ')}...`);
    }
    
    // Отправляем trade подписки
    if (tradeParams.length > 0) {
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: tradeParams,
      }));
      logger.info(`Subscribed to ${tradeParams.length} trade streams`);
    }
  }

  private sendSubscription(symbol: string, type: 'depth' | 'trade'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const param = type === 'depth'
      ? `spot@public.limit.depth.v3.api.pb@${symbol.toUpperCase()}@5`
      : `${symbol.toLowerCase()}@trade`;
    
    this.ws.send(JSON.stringify({
      method: 'SUBSCRIPTION',
      params: [param],
    }));
  }

  private handleBinaryMessage(data: WebSocket.RawData): void {
    if (!this.decoder) {
      logger.warn('ProtoDecoder not initialized');
      return;
    }

    const buffer = this.toBuffer(data);
    
    // Логирование для отладки
    logger.debug(`Received binary message: ${buffer.length} bytes, hex: ${buffer.subarray(0, 32).toString('hex')}`);

    try {
      const snapshot = this.decoder.decodeLimitDepth(buffer);

      if (!snapshot) {
        logger.debug('Decoder returned null');
        return;
      }

      logger.debug(`Decoded orderbook for ${snapshot.symbol}: ${snapshot.bids.length} bids, ${snapshot.asks.length} asks`);

      const orderbook: OrderBook = {
        symbol: snapshot.symbol,
        bids: snapshot.bids.map(([price, size]) => ({
          price: parseFloat(price),
          size: parseFloat(size),
        })),
        asks: snapshot.asks.map(([price, size]) => ({
          price: parseFloat(price),
          size: parseFloat(size),
        })),
        timestamp: Date.now(),
      };

      const handlers = this.orderBookHandlers.get(orderbook.symbol) || [];
      handlers.forEach(h => h(orderbook));
    } catch (error) {
      logger.error(`Cannot decode protobuf message: ${getErrorMessage(error)}`);
    }
  }

  private toBuffer(raw: WebSocket.RawData): Buffer {
    if (Array.isArray(raw)) {
      return Buffer.concat(raw);
    }
    if (raw instanceof ArrayBuffer) {
      return Buffer.from(raw);
    }
    return raw as Buffer;
  }

  private handleMessage(message: any): void {
    // JSON сообщения (trade, ping responses, errors)
    if (message.stream === 'trade') {
      const symbol = message.data.s.toUpperCase();
      const trade: Trade = {
        symbol,
        id: message.data.t,
        price: parseFloat(message.data.p),
        qty: parseFloat(message.data.q),
        quoteQty: parseFloat(message.data.P),
        time: message.data.T,
        isBuyerMaker: message.data.m,
      };
      const handlers = this.tradeHandlers.get(symbol) || [];
      handlers.forEach(h => h(trade));
    } else if (message.code !== undefined && message.code !== 0) {
      logger.error(`MEXC WebSocket error: ${JSON.stringify(message)}`);
    }
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnecting = false;
    }
  }
}
