import { Signal } from '../signals/types';

export interface PaperOrder {
  id: string;
  signal: Signal;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'PARTIAL';
  filledSize: number;
  avgFillPrice: number;
  timestamp: number;
  fillTimestamp?: number;
}

export interface PaperPosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  signal: Signal;
  openTimestamp: number;
}

export interface TradeResult {
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  commission: number;
  slippage: number;
  setupType: string;
  openTimestamp: number;
  closeTimestamp: number;
}
