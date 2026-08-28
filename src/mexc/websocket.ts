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

  constructor() {}

  public subscribeOrderBook(symbol: string, handler: OrderBookHandler): void {
    if (!this.orderBookHandlers.has(symbol)) {
      this.orderBookHandlers.set(symbol, []);
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

    const depthSymbols = Array.from(this.orderBookHandlers.keys());
    const tradeSymbols = Array.from(this.tradeHandlers.keys());

    if (depthSymbols.length > 0) {
      const depthParams = depthSymbols.map(s => `${s.toLowerCase()}@depth`);
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: depthParams,
      }));
      logger.info(`Subscribed to ${depthSymbols.length} depth streams`);
    }

    if (tradeSymbols.length > 0) {
      const tradeParams = tradeSymbols.map(s => `${s.toLowerCase()}@trade`);
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: tradeParams,
      }));
      logger.info(`Subscribed to ${tradeSymbols.length} trade streams`);
    }
  }

  private sendSubscription(symbol: string, type: 'depth' | 'trade'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const param = `${symbol.toLowerCase()}@${type}`;
    this.ws.send(JSON.stringify({
      method: 'SUBSCRIPTION',
      params: [param],
    }));
  }

  private handleMessage(message: any): void {
    if (message.stream === 'depth') {
      const orderbook: OrderBook = {
        symbol: message.data.s.toUpperCase(),
        bids: message.data.b.map((b: any[]) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })),
        asks: message.data.a.map((a: any[]) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })),
        timestamp: message.data.E,
      };
      const handlers = this.orderBookHandlers.get(orderbook.symbol) || [];
      handlers.forEach(h => h(orderbook));
    } else if (message.stream === 'trade') {
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
