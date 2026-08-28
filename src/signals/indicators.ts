import { Candle } from '../mexc/types';

export function calculateVWAP(candles: Candle[]): number {
  if (candles.length === 0) {
    return 0;
  }
  
  let totalVolume = 0;
  let totalValue = 0;
  
  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    totalVolume += candle.volume;
    totalValue += typicalPrice * candle.volume;
  }
  
  return totalVolume > 0 ? totalValue / totalVolume : 0;
}

export function calculateEMA(candles: Candle[], period: number): number {
  if (candles.length < period) {
    return 0;
  }
  
  const closes = candles.slice(-period).map(c => c.close);
  const multiplier = 2 / (period + 1);
  
  let ema = closes.reduce((sum, c) => sum + c, 0) / period;
  
  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
  }
  
  return ema;
}

export function calculateSupportResistance(candles: Candle[], lookback: number = 20): { support: number; resistance: number } {
  const recent = candles.slice(-lookback);
  const low = Math.min(...recent.map(c => c.low));
  const high = Math.max(...recent.map(c => c.high));
  return { support: low, resistance: high };
}

export function calculateMidPrice(bid: number, ask: number): number {
  return (bid + ask) / 2;
}
