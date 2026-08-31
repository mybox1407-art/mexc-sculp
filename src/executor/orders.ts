import { PaperOrder, PaperPosition, TradeResult } from './types';
import { Signal } from '../signals/types';
import { OrderBook } from '../mexc/types';
import { logger } from '../utils/logger';

// Комиссии MEXC Futures
const TAKER_FEE = 0.00032; // 0.032%

let orderCounter = 0;

export function isValidPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function getBestPrices(orderbook: OrderBook | null | undefined): {
  bestBid: number;
  bestAsk: number;
} | null {
  const bid = orderbook?.bids?.[0];
  const ask = orderbook?.asks?.[0];

  if (
    !bid ||
    !ask ||
    !isValidPrice(bid.price) ||
    !isValidPrice(ask.price)
  ) {
    return null;
  }

  // Ask ниже bid означает повреждённый/несогласованный стакан.
  if (ask.price < bid.price) {
    return null;
  }

  return {
    bestBid: bid.price,
    bestAsk: ask.price,
  };
}

function logInvalidOrderbook(context: string, symbol: string, orderbook: OrderBook | null | undefined): void {
  logger.warn(
    `[INVALID_ORDERBOOK:${context}] ${symbol} ` +
    `bids=${orderbook?.bids?.length ?? 0} ` +
    `asks=${orderbook?.asks?.length ?? 0} ` +
    `bid0=${JSON.stringify(orderbook?.bids?.[0] ?? null)} ` +
    `ask0=${JSON.stringify(orderbook?.asks?.[0] ?? null)}`
  );
}

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
  const prices = getBestPrices(orderbook);

  if (!prices) {
    logInvalidOrderbook('FILL', order.symbol, orderbook);
    return null;
  }

  const fillPrice = order.side === 'BUY'
    ? prices.bestAsk
    : prices.bestBid;

  if (!isValidPrice(order.entryPrice)) {
    logger.warn(
      `[INVALID_ORDER_ENTRY] ${order.symbol} entry=${order.entryPrice}; order ignored`
    );
    return null;
  }

  const slippage = Math.abs(fillPrice - order.entryPrice) / order.entryPrice;

  if (slippage > 0.01) {
    logger.warn(
      `High slippage detected for ${order.symbol}: ${(slippage * 100).toFixed(4)}% ` +
      `signalEntry=${order.entryPrice} fillPrice=${fillPrice}`
    );
  }

  order.status = 'FILLED';
  order.filledSize = order.size;
  order.avgFillPrice = fillPrice;
  order.fillTimestamp = Date.now();

  logger.debug(
    `[PAPER_FILL] ${order.symbol} ${order.side} ` +
    `size=${order.size} entry=${order.entryPrice} fill=${fillPrice} ` +
    `bid=${prices.bestBid} ask=${prices.bestAsk}`
  );

  return order;
}

/**
 * Возвращает цену рыночного выхода:
 * BUY закрывается продажей по best bid.
 * SELL закрывается покупкой по best ask.
 *
 * Возвращает null при невалидном стакане. Вызывающая сторона
 * должна пропустить обновление, а не закрывать позицию по вымышленной цене.
 */
export function calculateExitPrice(position: PaperPosition, orderbook: OrderBook): number | null {
  const prices = getBestPrices(orderbook);

  if (!prices) {
    logInvalidOrderbook('EXIT', position.symbol, orderbook);
    return null;
  }

  return position.side === 'BUY'
    ? prices.bestBid
    : prices.bestAsk;
}

export function shouldExitPosition(position: PaperPosition, signal: Signal): boolean {
  if (
    !isValidPrice(position.currentPrice) ||
    !isValidPrice(position.entryPrice)
  ) {
    logger.warn(
      `[INVALID_POSITION_PRICE] ${position.symbol} ` +
      `entry=${position.entryPrice} current=${position.currentPrice}`
    );
    return false;
  }

  /*
   * Оставляем только проверку Stop Loss.
   * TP1/TP2 обрабатываются в PaperExecutor через ATR-price targets.
   */
  if (position.side === 'BUY') {
    return position.currentPrice <= signal.stop;
  }

  return position.currentPrice >= signal.stop;
}

export function calculateTradeResult(position: PaperPosition, exitPrice: number): TradeResult {
  if (!isValidPrice(exitPrice)) {
    throw new Error(
      `Invalid exit price for ${position.symbol}: ${String(exitPrice)}`
    );
  }

  const grossPnl =
    (exitPrice - position.entryPrice) *
    position.size *
    (position.side === 'BUY' ? 1 : -1);

  // Комиссия: открытие + закрытие, обе стороны принимаются как taker.
  const commission =
    position.entryPrice * position.size * TAKER_FEE +
    exitPrice * position.size * TAKER_FEE;

  const slippage = 0;
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
