import { OrderBook, Candle } from '../mexc/types';

export interface DepthMetrics {
  bidDepth: number;
  askDepth: number;
  totalDepth: number;
}

export interface VolatilityMetrics {
  atr: number;
  stdDev: number;
  high24h: number;
  low24h: number;
  change24hPct: number;
}

export function calculateDepth(orderbook: OrderBook, levels: number = 5): DepthMetrics {
  const bidDepth = orderbook.bids.slice(0, levels).reduce((sum, level) => sum + level.price * level.size, 0);
  const askDepth = orderbook.asks.slice(0, levels).reduce((sum, level) => sum + level.price * level.size, 0);
  return { bidDepth, askDepth, totalDepth: bidDepth + askDepth };
}

export function calculateSpreadPct(orderbook: OrderBook): number {
  if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
    return Infinity;
  }
  const bestBid = orderbook.bids[0].price;
  const bestAsk = orderbook.asks[0].price;
  return ((bestAsk - bestBid) / bestBid) * 100;
}

export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period) {
    return 0;
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return 0;
  }

  const recentTR = trueRanges.slice(-period);
  return recentTR.reduce((sum, tr) => sum + tr, 0) / period;
}

export function calculateStdDev(candles: Candle[], period: number = 20): number {
  if (candles.length < period) {
    return 0;
  }

  const closes = candles.slice(-period).map(c => c.close);
  const mean = closes.reduce((sum, c) => sum + c, 0) / period;
  const squaredDiffs = closes.map(c => Math.pow(c - mean, 2));
  const variance = squaredDiffs.reduce((sum, sd) => sum + sd, 0) / period;
  return Math.sqrt(variance);
}

export function calculateVolatilityMetrics(candles: Candle[], change24hPct: number): VolatilityMetrics {
  const atr = calculateATR(candles, 14);
  const stdDev = calculateStdDev(candles, 20);
  const high24h = Math.max(...candles.slice(-24).map(c => c.high));
  const low24h = Math.min(...candles.slice(-24).map(c => c.low));
  
  return {
    atr,
    stdDev,
    high24h,
    low24h,
    change24hPct,
  };
}
