import { Signal } from './types';
import { calculateVWAP, calculateSupportResistance, calculateMidPrice } from './indicators';
import { OrderBook, Candle } from '../mexc/types';
import { config } from '../config';

export function generateVWAPSignal(candles: Candle[], orderbook: OrderBook, atr: number): Signal | null {
  const vwap = calculateVWAP(candles);
  const currentPrice = calculateMidPrice(orderbook.bids[0].price, orderbook.asks[0].price);
  const deviation = Math.abs(currentPrice - vwap) / vwap;

  if (deviation > atr * config.atrMultiple / vwap) {
    const side = currentPrice > vwap ? 'SELL' : 'BUY';
    const target = vwap;
    
    // SL от entry, а не от VWAP!
    const stop = side === 'BUY' 
      ? currentPrice - atr * config.slAtrMultiple  // BUY: SL ниже входа
      : currentPrice + atr * config.slAtrMultiple; // SELL: SL выше входа

    return {
      type: 'VWAP_MEAN_REVERSION',
      symbol: candles[0].symbol,
      side,
      entry: currentPrice,
      target,
      stop,
      timestamp: Date.now(),
      atr,
      vwap,
      confidence: 0.7,
    };
  }

  return null;
}

export function generateSpreadScalpSignal(candles: Candle[], orderbook: OrderBook, atr: number): Signal | null {
  const bestBid = orderbook.bids[0].price;
  const bestAsk = orderbook.asks[0].price;
  const spread = bestAsk - bestBid;
  const minSpread = atr * 0.5;

  if (spread >= minSpread && orderbook.bids[0].size > orderbook.asks[0].size * 1.5) {
    const entry = bestBid;
    const target = bestAsk;
    const stop = bestBid - atr * config.slAtrMultiple;

    return {
      type: 'SPREAD_SCALP',
      symbol: candles[0].symbol,
      side: 'BUY',
      entry,
      target,
      stop,
      timestamp: Date.now(),
      atr,
      confidence: 0.6,
    };
  }

  return null;
}

export function generateLiquiditySweepSignal(candles: Candle[], orderbook: OrderBook, atr: number): Signal | null {
  const { resistance, support } = calculateSupportResistance(candles, 20);
  const currentPrice = calculateMidPrice(orderbook.bids[0].price, orderbook.asks[0].price);

  if (currentPrice > resistance && currentPrice - resistance < atr * 0.5) {
    const entry = currentPrice;
    const target = resistance - atr * 0.5;
    const stop = resistance + atr * config.slAtrMultiple;

    return {
      type: 'LIQUIDITY_SWEEP',
      symbol: candles[0].symbol,
      side: 'SELL',
      entry,
      target,
      stop,
      timestamp: Date.now(),
      atr,
      confidence: 0.65,
    };
  }

  if (currentPrice < support && support - currentPrice < atr * 0.5) {
    const entry = currentPrice;
    const target = support + atr * 0.5;
    const stop = support - atr * config.slAtrMultiple;

    return {
      type: 'LIQUIDITY_SWEEP',
      symbol: candles[0].symbol,
      side: 'BUY',
      entry,
      target,
      stop,
      timestamp: Date.now(),
      atr,
      confidence: 0.65,
    };
  }

  return null;
}

export function generateSignals(candles: Candle[], orderbook: OrderBook, atr: number): Signal[] {
  const signals: Signal[] = [];

  const vwapSignal = generateVWAPSignal(candles, orderbook, atr);
  if (vwapSignal) signals.push(vwapSignal);

  const spreadSignal = generateSpreadScalpSignal(candles, orderbook, atr);
  if (spreadSignal) signals.push(spreadSignal);

  const sweepSignal = generateLiquiditySweepSignal(candles, orderbook, atr);
  if (sweepSignal) signals.push(sweepSignal);

  return signals;
}
