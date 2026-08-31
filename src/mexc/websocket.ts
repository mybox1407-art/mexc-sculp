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
    
    this.ws.send(JSON.stringify({
      method,
      param: { symbol: symbol.toUpperCase() },
      gzip: false,
    }));
  }

  private handleMessage(message: any): void {
    const channel = String(message.channel ?? '');
    const data = message.data;
    const symbol = String(message.symbol ?? '');

    if (channel === 'push.depth' && data && symbol) {
      const existing = this.orderBooks.get(symbol);
      const isSnapshot = !existing || (data.version !== undefined && data.version === 1);
      
      if (isSnapshot) {
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
        
        this.orderBooks.set(symbol, orderbook);
        
        const handlers = this.orderBookHandlers.get(symbol) || [];
        handlers.forEach(h => h(orderbook));
      } else {
        // ✅ Лог: проверяем инверсию в диффе от MEXC
        const rawBids = (data.bids || []).map((b: any) => parseFloat(b[0]));
        const rawAsks = (data.asks || []).map((a: any) => parseFloat(a[0]));
        
        if (rawBids.length > 0 && rawAsks.length > 0) {
          const maxBid = Math.max(...rawBids);
          const minAsk = Math.min(...rawAsks);
          
          if (maxBid >= minAsk) {
            logger.warn(
              `[INVERTED_DIFF] ${symbol} ` +
              `maxBid=${maxBid} minAsk=${minAsk} ` +
              `bids=${JSON.stringify(rawBids.slice(0, 5))} ` +
              `asks=${JSON.stringify(rawAsks.slice(0, 5))}`
            );
          }
        }
        
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
        
        // ✅ Лог: проверяем инверсию после мерджа
        if (existing.bids.length > 0 && existing.asks.length > 0) {
          const bestBid = existing.bids[0].price;
          const bestAsk = existing.asks[0].price;
          
          if (bestBid >= bestAsk) {
            logger.warn(
              `[INVERTED_OB:SEND] ${symbol} ` +
              `bid=${bestBid} ask=${bestAsk} ` +
              `bidsLen=${existing.bids.length} asksLen=${existing.asks.length}`
            );
          }
        }
        
        this.orderBooks.set(symbol, existing);
        
        const handlers = this.orderBookHandlers.get(symbol) || [];
        handlers.forEach(h => h(existing));
      }
    } else if (channel === 'push.deal' && data && symbol) {
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
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnecting = false;
    }
  }
}
