import { TradeResult } from './types';

export interface Stats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  totalCommission: number;
  totalSlippage: number;
  netPnl: number;
  bySetupType: Record<string, { trades: number; winRate: number; avgPnl: number; totalPnl: number }>;
}

export function calculateStats(tradeResults: TradeResult[]): Stats {
  const totalTrades = tradeResults.length;
  const winningTrades = tradeResults.filter(t => t.pnl > 0).length;
  const losingTrades = tradeResults.filter(t => t.pnl <= 0).length;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
  const totalPnl = tradeResults.reduce((sum, t) => sum + t.pnl, 0);
  const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;

  const wins = tradeResults.filter(t => t.pnl > 0);
  const losses = tradeResults.filter(t => t.pnl <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : 0;

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const totalCommission = tradeResults.reduce((sum, t) => sum + t.commission, 0);
  const totalSlippage = tradeResults.reduce((sum, t) => sum + t.slippage, 0);
  const netPnl = totalPnl - totalCommission - totalSlippage;

  const bySetupType: Record<string, { trades: number; winRate: number; avgPnl: number; totalPnl: number }> = {};
  for (const setupType of new Set(tradeResults.map(t => t.setupType))) {
    const setupTrades = tradeResults.filter(t => t.setupType === setupType);
    const setupWins = setupTrades.filter(t => t.pnl > 0).length;
    const setupWinRate = setupTrades.length > 0 ? setupWins / setupTrades.length : 0;
    const setupAvgPnl = setupTrades.length > 0 ? setupTrades.reduce((sum, t) => sum + t.pnl, 0) / setupTrades.length : 0;
    const setupTotalPnl = setupTrades.reduce((sum, t) => sum + t.pnl, 0);
    bySetupType[setupType] = { trades: setupTrades.length, winRate: setupWinRate, avgPnl: setupAvgPnl, totalPnl: setupTotalPnl };
  }

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    totalPnl,
    avgPnl,
    avgWin,
    avgLoss,
    profitFactor,
    totalCommission,
    totalSlippage,
    netPnl,
    bySetupType,
  };
}
