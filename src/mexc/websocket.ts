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
  private baseUrl: string = 'wss://wbs.mexc.com/ws';
  private isConnecting: boolean = false;
  private pendingSubscriptions: Set<string> = new Set();

  constructor() {}

  public subscribeOrderBook(symbol: string, handler: OrderBookHandler): void {
    if (!this.orderBookHandlers.has(symbol)) {
      this.orderBookHandlers.set(symbol, []);
      // Правильный формат для MEXC
      this.pendingSubscriptions.add(`spot@public.limit.depth.v3.api.pb@${symbol.toUpperCase()}@5`);
    }
    this.orderBookHandlers.get(symbol)!.push(handler);
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(symbol, 'depth');
    } else if (!this.isConnecting) {
      this.connect();
    }
  }

  public subscribeTrades(symbol: string, handler: TradeHandler): void {
    if (!this.tradeHandlers.has(symbol)) {
      this.tradeHandlers.set(symbol, []);
      this.pendingSubscriptions.add(`${symbol.toLowerCase()}@trade`);
    }
    this.tradeHandlers.get(symbol)!.push(handler);
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(symbol, 'trade');
    } else if (!this.isConnecting) {
      this.connect();
    }
  }

  private connect(): void {
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
        // Бинарные protobuf сообщения игнорируем
        logger.debug(`Received binary/protobuf message`);
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

    logger.info(`Sending ${this.pendingSubscriptions.size} pending subscriptions`);
    
    // Отправляем подписки
    const subscriptions = Array.from(this.pendingSubscriptions);
    this.ws.send(JSON.stringify({
      method: 'SUBSCRIPTION',
      params: subscriptions,
    }));
    
    logger.info(`Subscribed to: ${subscriptions.slice(0, 5).join(', ')}...`);
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

  private handleMessage(message: any): void {
    // JSON сообщения (например, trade)
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
