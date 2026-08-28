import { OrderBook, Trade } from '../mexc/types';
import { DepthMetrics } from './metrics';

export interface WallDetectionResult {
  hasWalls: boolean;
  maxBidPct: number;
  maxAskPct: number;
}

export interface VolumeMismatchResult {
  hasMismatch: boolean;
  orderbookVolume: number;
  tradesVolume: number;
  ratio: number;
}

export function detectWalls(orderbook: OrderBook, thresholdPct: number = 5): WallDetectionResult {
  const totalBid = orderbook.bids.reduce((sum, l) => sum + l.size, 0);
  const totalAsk = orderbook.asks.reduce((sum, l) => sum + l.size, 0);
  
  const maxBid = orderbook.bids.length > 0 ? Math.max(...orderbook.bids.map(l => l.size)) : 0;
  const maxAsk = orderbook.asks.length > 0 ? Math.max(...orderbook.asks.map(l => l.size)) : 0;
  
  const maxBidPct = totalBid > 0 ? (maxBid / totalBid) * 100 : 0;
  const maxAskPct = totalAsk > 0 ? (maxAsk / totalAsk) * 100 : 0;
  
  return {
    hasWalls: maxBidPct > thresholdPct || maxAskPct > thresholdPct,
    maxBidPct,
    maxAskPct,
  };
}

export function detectVolumeMismatch(
  orderbook: OrderBook,
  recentTrades: Trade[],
  windowMs: number = 60000
): VolumeMismatchResult {
  const orderbookVolume = orderbook.bids.reduce((sum, l) => sum + l.size, 0) + 
                          orderbook.asks.reduce((sum, l) => sum + l.size, 0);
  
  const now = Date.now();
  const recentTradesVolume = recentTrades
    .filter(t => now - t.time < windowMs)
    .reduce((sum, t) => sum + t.qty, 0);
  
  const ratio = orderbookVolume > 0 ? recentTradesVolume / orderbookVolume : 0;
  
  return {
    hasMismatch: ratio < 0.1 || ratio > 10,
    orderbookVolume,
    tradesVolume: recentTradesVolume,
    ratio,
  };
}

export function detectRevivalPattern(
  orderbookHistory: OrderBook[],
  windowSize: number = 10
): boolean {
  if (orderbookHistory.length < windowSize) {
    return false;
  }
  
  const recent = orderbookHistory.slice(-windowSize);
  const depths = recent.map(ob => ob.bids.reduce((sum, l) => sum + l.size, 0) + ob.asks.reduce((sum, l) => sum + l.size, 0));
  
  const avgDepth = depths.reduce((sum, d) => sum + d, 0) / depths.length;
  const lastDepth = depths[depths.length - 1];
  
  return lastDepth > avgDepth * 2;
}

export function isTokenSupported(
  depth: DepthMetrics,
  spreadPct: number,
  wallResult: WallDetectionResult,
  volumeResult: VolumeMismatchResult,
  revivalPattern: boolean,
  minDepthUsd: number,
  maxSpreadPct: number
): boolean {
  if (depth.totalDepth < minDepthUsd) {
    return false;
  }
  
  if (spreadPct > maxSpreadPct) {
    return false;
  }
  
  return wallResult.hasWalls || volumeResult.hasMismatch || revivalPattern;
}
