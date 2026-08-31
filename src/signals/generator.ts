import { Signal } from './types';
import { calculateVWAP, calculateSupportResistance, calculateMidPrice } from './indicators';
import { OrderBook, Candle } from '../mexc/types';
import { config } from '../config';
import { logger } from '../utils/logger';

export function generateVWAPSignal(candles: Candle[], orderbook: OrderBook, atr: number): Signal | null {
  // ✅ Фильтр по объёму: мин. средний объём за 20 свечей
  const avgVolume = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  if (avgVolume < config.minAvgVolume) {
    logger.debug(`Volume filter: ${candles[0]?.symbol} avgVolume=${avgVolume.toFixed(2)} < ${config.minAvgVolume}`);
    return null;
  }

  const vwap = calculateVWAP(candles);
  const currentPrice = calculateMidPrice(orderbook.bids[0].price, orderbook.asks[0].price);
  const deviation = Math.abs(currentPrice - vwap) / vwap;

  // ✅ Вход: ×1.5 ATR
  if (deviation > atr * config.atrMultiple * 1.5 / vwap) {
    const side = currentPrice > vwap ? 'SELL' : 'BUY';
    
    // ✅ MFE фильтр ОТКЛЮЧЁН — блокировал все сигналы
    // const { resistance, support } = calculateSupportResistance(candles, 20);
    // const distanceToResistance = (resistance - currentPrice) / currentPrice;
    // const distanceToSupport = (currentPrice - support) / currentPrice;
    // const targetDistance = Math.abs(vwap - currentPrice) / currentPrice;
    // if (side === 'BUY' && distanceToResistance < targetDistance * 0.3) { return null; }
    // if (side === 'SELL' && distanceToSupport < targetDistance * 0.3) { return null; }

    // ✅ TP = entry ± ATR × tpAtrMultiple
    const tpDistance = atr * config.tpAtrMultiple1;
    const target = side === 'BUY'
      ? currentPrice + tpDistance
      : currentPrice - tpDistance;
    
    // SL от entry: entry ± ATR × slAtrMultiple
    const stop = side === 'BUY' 
      ? currentPrice - atr * config.slAtrMultiple
      : currentPrice + atr * config.slAtrMultiple;

    logger.debug(`Signal: ${candles[0]?.symbol} ${side} entry=${currentPrice.toFixed(4)} target=${target.toFixed(4)} stop=${stop.toFixed(4)} dev=${(deviation * 100).toFixed(2)}%`);

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

// ✅ SPREAD_SCALP отключён - стратегия показывает убыточные результаты
export function generateSpreadScalpSignal(_candles: Candle[], _orderbook: OrderBook, _atr: number): Signal | null {
  logger.debug(`SPREAD_SCALP strategy disabled, skipping`);
  return null;
}

export function generateLiquiditySweepSignal(_candles: Candle[], _orderbook: OrderBook, _atr: number): Signal | null {
  logger.debug(`LIQUIDITY_SWEEP strategy disabled, skipping`);
  return null;
}

export function generateSignals(candles: Candle[], orderbook: OrderBook, atr: number): Signal[] {
  const signals: Signal[] = [];

  const vwapSignal = generateVWAPSignal(candles, orderbook, atr);
  if (vwapSignal) signals.push(vwapSignal);

  // ✅ SPREAD_SCALP отключён
  // const spreadSignal = generateSpreadScalpSignal(candles, orderbook, atr);
  // if (spreadSignal) signals.push(spreadSignal);

  // ✅ LIQUIDITY_SWEEP отключён
  // const sweepSignal = generateLiquiditySweepSignal(candles, orderbook, atr);
  // if (sweepSignal) signals.push(sweepSignal);

  return signals;
}
