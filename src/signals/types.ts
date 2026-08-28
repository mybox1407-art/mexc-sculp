export type SignalType = 'VWAP_MEAN_REVERSION' | 'SPREAD_SCALP' | 'LIQUIDITY_SWEEP';

export type SignalSide = 'BUY' | 'SELL';

export interface Signal {
  type: SignalType;
  symbol: string;
  side: SignalSide;
  entry: number;
  target: number;
  stop: number;
  timestamp: number;
  atr: number;
  vwap?: number;
  confidence?: number;
}
