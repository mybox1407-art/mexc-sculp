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

  // ✅ Ужесточено: ×2 ATR вместо ×1.5
  if (deviation > atr * config.atrMultiple * 2 / vwap) {
    const side = currentPrice > vwap ? 'SELL' : 'BUY';
    
    // ✅ MFE фильтр: проверка距离 до support/resistance
    const { resistance, support } = calculateSupportResistance(candles, 20);
    const distanceToResistance = (resistance - currentPrice) / currentPrice;
    const distanceToSupport = (currentPrice - support) / currentPrice;
    
    // Если цена ближе 0.5% к уровню — пропускать сигнал
    if (side === 'BUY' && distanceToResistance < 0.005) {
      logger.debug(`MFE filter: ${candles[0]?.symbol} too close to resistance (${(distanceToResistance * 100).toFixed(2)}%)`);
      return null;
    }
    if (side === 'SELL' && distanceToSupport < 0.005) {
      logger.debug(`MFE filter: ${candles[0]?.symbol} too close to support (${(distanceToSupport * 100).toFixed(2)}%)`);
      return null;
    }

    // ✅ Momentum фильтр: проверка направления цены (последние 3 свечи)
    const recentCandles = candles.slice(-3);
    if (recentCandles.length >= 3) {
      const firstClose = recentCandles[0].close;
      const lastClose = recentCandles[2].close;
      
      // Если цена уже разворачивается в нашу сторону — пропускать (ждать дальше)
      if (side === 'BUY' && lastClose < firstClose) {
        logger.debug(`Momentum filter: ${candles[0]?.symbol} price already reversing up, skipping BUY`);
        return null;
      }
      if (side === 'SELL' && lastClose > firstClose) {
        logger.debug(`Momentum filter: ${candles[0]?.symbol} price already reversing down, skipping SELL`);
        return null;
      }
    }

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
