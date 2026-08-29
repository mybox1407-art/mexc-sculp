import { PaperOrder, PaperPosition, TradeResult } from './types';
import { Signal } from '../signals/types';
import { OrderBook } from '../mexc/types';
import { config } from '../config';
import { logger } from '../utils/logger';

// Комиссии MEXC Futures
const MAKER_FEE = 0.00008;   // 0.008%
const TAKER_FEE = 0.00032;   // 0.032%

let orderCounter = 0;

export function createPaperOrder(signal: Signal, size: number): PaperOrder {
  orderCounter++;
  return {
    id: `order_${orderCounter}_${Date.now()}`,
    signal,
    symbol: signal.symbol,
    side: signal.side,
    entryPrice: signal.entry,
    size,
    status: 'PENDING',
    filledSize: 0,
    avgFillPrice: 0,
    timestamp: Date.now(),
  };
}

export function simulateOrderFill(order: PaperOrder, orderbook: OrderBook): PaperOrder | null {
  const bestBid = orderbook.bids[0].price;
  const bestAsk = orderbook.asks[0].price;

  let fillPrice: number;
  if (order.side === 'BUY') {
    if (order.entryPrice >= bestAsk) {
      fillPrice = bestAsk;
    } else {
      return null;
    }
  } else {
    if (order.entryPrice <= bestBid) {
      fillPrice = bestBid;
    } else {
      return null;
    }
  }

  const slippage = Math.abs(fillPrice - order.entryPrice) / order.entryPrice;
  if (slippage > 0.01) {
    logger.warn(`High slippage detected for ${order.symbol}: ${slippage * 100}%`);
  }

  order.status = 'FILLED';
  order.filledSize = order.size;
  order.avgFillPrice = fillPrice;
  order.fillTimestamp = Date.now();

  return order;
}

export function calculateExitPrice(position: PaperPosition, orderbook: OrderBook): number {
  if (position.side === 'BUY') {
    return orderbook.bids[0].price;
  } else {
    return orderbook.asks[0].price;
  }
}

export function shouldExitPosition(position: PaperPosition, signal: Signal): boolean {
  const pnlPct = (position.currentPrice - position.entryPrice) / position.entryPrice * 100 * (position.side === 'BUY' ? 1 : -1);

  // Проверка TP
  if (pnlPct >= config.tpPct1 || pnlPct >= config.tpPct2) {
    return true;
  }

  // Проверка SL — по направлению!
  if (position.side === 'BUY') {
    if (position.currentPrice <= signal.stop) {  // BUY: SL ниже
      return true;
    }
  } else {
    if (position.currentPrice >= signal.stop) {  // SELL: SL выше
      return true;
    }
  }

  return false;
}

export function calculateTradeResult(position: PaperPosition, exitPrice: number): TradeResult {
  const grossPnl = (exitPrice - position.entryPrice) * position.size * (position.side === 'BUY' ? 1 : -1);
  
  // Комиссия: открытие + закрытие (Taker)
  const commission = position.entryPrice * position.size * TAKER_FEE + 
                     exitPrice * position.size * TAKER_FEE;
  
  const slippage = Math.abs(exitPrice - position.currentPrice) * position.size;
  const pnl = grossPnl - commission - slippage;
  const pnlPct = (pnl / (position.entryPrice * position.size)) * 100;

  return {
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    size: position.size,
    pnl,
    pnlPct,
    commission,
    slippage,
    setupType: position.signal.type,
    openTimestamp: position.openTimestamp,
    closeTimestamp: Date.now(),
  };
}
