import { createObjectCsvWriter } from 'csv-writer';
import * as fs from 'fs';
import * as path from 'path';
import { TradeResult } from '../executor/types';
import { ScannedToken } from '../scanner/scanner';
import { Signal } from '../signals/types';
import { PaperPosition } from '../executor/paper';
import { logger } from '../utils/logger';
import { config } from '../config';

const OUTPUT_DIR = path.join(__dirname, '../../', config.csvOutputPath);

export interface ScanLogEntry {
  timestamp: number;
  timestampFormatted: string;
  symbol: string;
  depth: number;
  spreadPct: number;
  atr: number;
  change24hPct: number;
  hasWalls: boolean;
  hasVolumeMismatch: boolean;
  hasRevivalPattern: boolean;
  isSupported: boolean;
  candlesCount: number;
  tradesCount: number;
  orderbookBidsCount: number;
  orderbookAsksCount: number;
}

export interface SignalLogEntry {
  timestamp: number;
  timestampFormatted: string;
  symbol: string;
  signalType: string;
  side: string;
  entry: number;
  target: number;
  stop: number;
  atr: number;
  vwap: number;
  confidence: number;
  executed: boolean;
}

export interface PositionLogEntry {
  timestamp: number;
  timestampFormatted: string;
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  signalType: string;
  openTimestamp: number;
  openTimestampFormatted: string;
  durationMinutes: number;
}

export interface TradeLogEntry {
  timestamp: number;
  timestampFormatted: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  commission: number;
  slippage: number;
  netPnl: number;
  setupType: string;
  openTimestamp: number;
  openTimestampFormatted: string;
  closeTimestamp: number;
  closeTimestampFormatted: string;
  durationMinutes: number;
  exitReason: string;
  highestUnrealizedPnl: number;
  lowestUnrealizedPnl: number;
  avgHoldTimeMinutes: number;
}

export interface DailyStatsEntry {
  date: string;
  timestamp: number;
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
  balance: number;
  totalScans: number;
  totalSignals: number;
  totalExecutions: number;
}

function ensureDirectory(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    logger.info(`Created output directory: ${OUTPUT_DIR}`);
  }
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getCsvFilePath(filename: string): string {
  return path.join(OUTPUT_DIR, filename);
}

export function initializeCsvFiles(): void {
  ensureDirectory();

  const scanWriter = createObjectCsvWriter({
    path: getCsvFilePath('scans.csv'),
    header: [
      { id: 'timestamp', title: 'TIMESTAMP' },
      { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
      { id: 'symbol', title: 'SYMBOL' },
      { id: 'depth', title: 'DEPTH_USD' },
      { id: 'spreadPct', title: 'SPREAD_PCT' },
      { id: 'atr', title: 'ATR' },
      { id: 'change24hPct', title: 'CHANGE_24H_PCT' },
      { id: 'hasWalls', title: 'HAS_WALLS' },
      { id: 'hasVolumeMismatch', title: 'HAS_VOLUME_MISMATCH' },
      { id: 'hasRevivalPattern', title: 'HAS_REVIVAL_PATTERN' },
      { id: 'isSupported', title: 'IS_SUPPORTED' },
      { id: 'candlesCount', title: 'CANDLES_COUNT' },
      { id: 'tradesCount', title: 'TRADES_COUNT' },
      { id: 'orderbookBidsCount', title: 'ORDERBOOK_BIDS_COUNT' },
      { id: 'orderbookAsksCount', title: 'ORDERBOOK_ASKS_COUNT' },
    ],
  });
  scanWriter.writeRecords([]);

  const signalWriter = createObjectCsvWriter({
    path: getCsvFilePath('signals.csv'),
    header: [
      { id: 'timestamp', title: 'TIMESTAMP' },
      { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
      { id: 'symbol', title: 'SYMBOL' },
      { id: 'signalType', title: 'SIGNAL_TYPE' },
      { id: 'side', title: 'SIDE' },
      { id: 'entry', title: 'ENTRY' },
      { id: 'target', title: 'TARGET' },
      { id: 'stop', title: 'STOP' },
      { id: 'atr', title: 'ATR' },
      { id: 'vwap', title: 'VWAP' },
      { id: 'confidence', title: 'CONFIDENCE' },
      { id: 'executed', title: 'EXECUTED' },
    ],
  });
  signalWriter.writeRecords([]);

  const positionWriter = createObjectCsvWriter({
    path: getCsvFilePath('positions.csv'),
    header: [
      { id: 'timestamp', title: 'TIMESTAMP' },
      { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
      { id: 'symbol', title: 'SYMBOL' },
      { id: 'side', title: 'SIDE' },
      { id: 'size', title: 'SIZE' },
      { id: 'entryPrice', title: 'ENTRY_PRICE' },
      { id: 'currentPrice', title: 'CURRENT_PRICE' },
      { id: 'unrealizedPnl', title: 'UNREALIZED_PNL' },
      { id: 'unrealizedPnlPct', title: 'UNREALIZED_PNL_PCT' },
      { id: 'signalType', title: 'SIGNAL_TYPE' },
      { id: 'openTimestamp', title: 'OPEN_TIMESTAMP' },
      { id: 'openTimestampFormatted', title: 'OPEN_TIMESTAMP_FORMATTED' },
      { id: 'durationMinutes', title: 'DURATION_MINUTES' },
    ],
  });
  positionWriter.writeRecords([]);

  const tradeWriter = createObjectCsvWriter({
    path: getCsvFilePath('trades.csv'),
    header: [
      { id: 'timestamp', title: 'TIMESTAMP' },
      { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
      { id: 'symbol', title: 'SYMBOL' },
      { id: 'side', title: 'SIDE' },
      { id: 'entryPrice', title: 'ENTRY_PRICE' },
      { id: 'exitPrice', title: 'EXIT_PRICE' },
      { id: 'size', title: 'SIZE' },
      { id: 'pnl', title: 'PNL' },
      { id: 'pnlPct', title: 'PNL_PCT' },
      { id: 'commission', title: 'COMMISSION' },
      { id: 'slippage', title: 'SLIPPAGE' },
      { id: 'netPnl', title: 'NET_PNL' },
      { id: 'setupType', title: 'SETUP_TYPE' },
      { id: 'openTimestamp', title: 'OPEN_TIMESTAMP' },
      { id: 'openTimestampFormatted', title: 'OPEN_TIMESTAMP_FORMATTED' },
      { id: 'closeTimestamp', title: 'CLOSE_TIMESTAMP' },
      { id: 'closeTimestampFormatted', title: 'CLOSE_TIMESTAMP_FORMATTED' },
      { id: 'durationMinutes', title: 'DURATION_MINUTES' },
      { id: 'exitReason', title: 'EXIT_REASON' },
      { id: 'highestUnrealizedPnl', title: 'HIGHEST_UNREALIZED_PNL' },
      { id: 'lowestUnrealizedPnl', title: 'LOWEST_UNREALIZED_PNL' },
      { id: 'avgHoldTimeMinutes', title: 'AVG_HOLD_TIME_MINUTES' },
    ],
  });
  tradeWriter.writeRecords([]);

  const dailyStatsWriter = createObjectCsvWriter({
    path: getCsvFilePath('daily_stats.csv'),
    header: [
      { id: 'date', title: 'DATE' },
      { id: 'timestamp', title: 'TIMESTAMP' },
      { id: 'totalTrades', title: 'TOTAL_TRADES' },
      { id: 'winningTrades', title: 'WINNING_TRADES' },
      { id: 'losingTrades', title: 'LOSING_TRADES' },
      { id: 'winRate', title: 'WIN_RATE' },
      { id: 'totalPnl', title: 'TOTAL_PNL' },
      { id: 'avgPnl', title: 'AVG_PNL' },
      { id: 'avgWin', title: 'AVG_WIN' },
      { id: 'avgLoss', title: 'AVG_LOSS' },
      { id: 'profitFactor', title: 'PROFIT_FACTOR' },
      { id: 'totalCommission', title: 'TOTAL_COMMISSION' },
      { id: 'totalSlippage', title: 'TOTAL_SLIPPAGE' },
      { id: 'netPnl', title: 'NET_PNL' },
      { id: 'balance', title: 'BALANCE' },
      { id: 'totalScans', title: 'TOTAL_SCANS' },
      { id: 'totalSignals', title: 'TOTAL_SIGNALS' },
      { id: 'totalExecutions', title: 'TOTAL_EXECUTIONS' },
    ],
  });
  dailyStatsWriter.writeRecords([]);

  logger.info('CSV files initialized');
}

export function logScan(tokens: ScannedToken[], scanTime: number): void {
  try {
    const csvWriter = createObjectCsvWriter({
      path: getCsvFilePath('scans.csv'),
      header: [
        { id: 'timestamp', title: 'TIMESTAMP' },
        { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
        { id: 'symbol', title: 'SYMBOL' },
        { id: 'depth', title: 'DEPTH_USD' },
        { id: 'spreadPct', title: 'SPREAD_PCT' },
        { id: 'atr', title: 'ATR' },
        { id: 'change24hPct', title: 'CHANGE_24H_PCT' },
        { id: 'hasWalls', title: 'HAS_WALLS' },
        { id: 'hasVolumeMismatch', title: 'HAS_VOLUME_MISMATCH' },
        { id: 'hasRevivalPattern', title: 'HAS_REVIVAL_PATTERN' },
        { id: 'isSupported', title: 'IS_SUPPORTED' },
        { id: 'candlesCount', title: 'CANDLES_COUNT' },
        { id: 'tradesCount', title: 'TRADES_COUNT' },
        { id: 'orderbookBidsCount', title: 'ORDERBOOK_BIDS_COUNT' },
        { id: 'orderbookAsksCount', title: 'ORDERBOOK_ASKS_COUNT' },
      ],
      append: true,
    });

    const records: ScanLogEntry[] = tokens.map(token => ({
      timestamp: scanTime,
      timestampFormatted: formatTimestamp(scanTime),
      symbol: token.symbol,
      depth: token.depth,
      spreadPct: token.spreadPct,
      atr: token.atr,
      change24hPct: token.change24hPct,
      hasWalls: token.hasWalls,
      hasVolumeMismatch: token.hasVolumeMismatch,
      hasRevivalPattern: token.hasRevivalPattern,
      isSupported: true,
      candlesCount: token.candles.length,
      tradesCount: token.trades.length,
      orderbookBidsCount: token.orderbook.bids.length,
      orderbookAsksCount: token.orderbook.asks.length,
    }));

    csvWriter.writeRecords(records);
    if (config.logScannerDetails) {
      logger.debug(`Logged ${records.length} scan entries`);
    }
  } catch (error) {
    logger.error('Error logging scan:', error);
  }
}

export function logSignal(signal: Signal, executed: boolean): void {
  try {
    const csvWriter = createObjectCsvWriter({
      path: getCsvFilePath('signals.csv'),
      header: [
        { id: 'timestamp', title: 'TIMESTAMP' },
        { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
        { id: 'symbol', title: 'SYMBOL' },
        { id: 'signalType', title: 'SIGNAL_TYPE' },
        { id: 'side', title: 'SIDE' },
        { id: 'entry', title: 'ENTRY' },
        { id: 'target', title: 'TARGET' },
        { id: 'stop', title: 'STOP' },
        { id: 'atr', title: 'ATR' },
        { id: 'vwap', title: 'VWAP' },
        { id: 'confidence', title: 'CONFIDENCE' },
        { id: 'executed', title: 'EXECUTED' },
      ],
      append: true,
    });

    const record: SignalLogEntry = {
      timestamp: signal.timestamp,
      timestampFormatted: formatTimestamp(signal.timestamp),
      symbol: signal.symbol,
      signalType: signal.type,
      side: signal.side,
      entry: signal.entry,
      target: signal.target,
      stop: signal.stop,
      atr: signal.atr,
      vwap: signal.vwap || 0,
      confidence: signal.confidence || 0,
      executed,
    };

    csvWriter.writeRecords([record]);
    if (config.logSignalDetails) {
      logger.debug(`Logged signal: ${signal.type} ${signal.symbol} ${signal.side}`);
    }
  } catch (error) {
    logger.error('Error logging signal:', error);
  }
}

export function logPosition(position: PaperPosition): void {
  try {
    const csvWriter = createObjectCsvWriter({
      path: getCsvFilePath('positions.csv'),
      header: [
        { id: 'timestamp', title: 'TIMESTAMP' },
        { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
        { id: 'symbol', title: 'SYMBOL' },
        { id: 'side', title: 'SIDE' },
        { id: 'size', title: 'SIZE' },
        { id: 'entryPrice', title: 'ENTRY_PRICE' },
        { id: 'currentPrice', title: 'CURRENT_PRICE' },
        { id: 'unrealizedPnl', title: 'UNREALIZED_PNL' },
        { id: 'unrealizedPnlPct', title: 'UNREALIZED_PNL_PCT' },
        { id: 'signalType', title: 'SIGNAL_TYPE' },
        { id: 'openTimestamp', title: 'OPEN_TIMESTAMP' },
        { id: 'openTimestampFormatted', title: 'OPEN_TIMESTAMP_FORMATTED' },
        { id: 'durationMinutes', title: 'DURATION_MINUTES' },
      ],
      append: true,
    });

    const now = Date.now();
    const durationMinutes = (now - position.openTimestamp) / 1000 / 60;
    const unrealizedPnlPct = (position.unrealizedPnl / (position.entryPrice * position.size)) * 100;

    const record: PositionLogEntry = {
      timestamp: now,
      timestampFormatted: formatTimestamp(now),
      symbol: position.symbol,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      unrealizedPnl: position.unrealizedPnl,
      unrealizedPnlPct,
      signalType: position.signal.type,
      openTimestamp: position.openTimestamp,
      openTimestampFormatted: formatTimestamp(position.openTimestamp),
      durationMinutes,
    };

    csvWriter.writeRecords([record]);
  } catch (error) {
    logger.error('Error logging position:', error);
  }
}

export function logTrade(trade: TradeResult, exitReason: string, highestPnl: number, lowestPnl: number, avgHoldTime: number): void {
  try {
    const csvWriter = createObjectCsvWriter({
      path: getCsvFilePath('trades.csv'),
      header: [
        { id: 'timestamp', title: 'TIMESTAMP' },
        { id: 'timestampFormatted', title: 'TIMESTAMP_FORMATTED' },
        { id: 'symbol', title: 'SYMBOL' },
        { id: 'side', title: 'SIDE' },
        { id: 'entryPrice', title: 'ENTRY_PRICE' },
        { id: 'exitPrice', title: 'EXIT_PRICE' },
        { id: 'size', title: 'SIZE' },
        { id: 'pnl', title: 'PNL' },
        { id: 'pnlPct', title: 'PNL_PCT' },
        { id: 'commission', title: 'COMMISSION' },
        { id: 'slippage', title: 'SLIPPAGE' },
        { id: 'netPnl', title: 'NET_PNL' },
        { id: 'setupType', title: 'SETUP_TYPE' },
        { id: 'openTimestamp', title: 'OPEN_TIMESTAMP' },
        { id: 'openTimestampFormatted', title: 'OPEN_TIMESTAMP_FORMATTED' },
        { id: 'closeTimestamp', title: 'CLOSE_TIMESTAMP' },
        { id: 'closeTimestampFormatted', title: 'CLOSE_TIMESTAMP_FORMATTED' },
        { id: 'durationMinutes', title: 'DURATION_MINUTES' },
        { id: 'exitReason', title: 'EXIT_REASON' },
        { id: 'highestUnrealizedPnl', title: 'HIGHEST_UNREALIZED_PNL' },
        { id: 'lowestUnrealizedPnl', title: 'LOWEST_UNREALIZED_PNL' },
        { id: 'avgHoldTimeMinutes', title: 'AVG_HOLD_TIME_MINUTES' },
      ],
      append: true,
    });

    const durationMinutes = (trade.closeTimestamp - trade.openTimestamp) / 1000 / 60;
    const netPnl = trade.pnl - trade.commission - trade.slippage;

    const record: TradeLogEntry = {
      timestamp: trade.closeTimestamp,
      timestampFormatted: formatTimestamp(trade.closeTimestamp),
      symbol: trade.symbol,
      side: trade.side,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      size: trade.size,
      pnl: trade.pnl,
      pnlPct: trade.pnlPct,
      commission: trade.commission,
      slippage: trade.slippage,
      netPnl,
      setupType: trade.setupType,
      openTimestamp: trade.openTimestamp,
      openTimestampFormatted: formatTimestamp(trade.openTimestamp),
      closeTimestamp: trade.closeTimestamp,
      closeTimestampFormatted: formatTimestamp(trade.closeTimestamp),
      durationMinutes,
      exitReason,
      highestUnrealizedPnl: highestPnl,
      lowestUnrealizedPnl: lowestPnl,
      avgHoldTimeMinutes: avgHoldTime,
    };

    csvWriter.writeRecords([record]);
    logger.info(`Logged trade: ${trade.symbol} | PnL: ${trade.pnl} (${trade.pnlPct}%) | Net: ${netPnl}`);
  } catch (error) {
    logger.error('Error logging trade:', error);
  }
}

export function logDailyStats(stats: any, balance: number, totalScans: number, totalSignals: number, totalExecutions: number): void {
  try {
    const csvWriter = createObjectCsvWriter({
      path: getCsvFilePath('daily_stats.csv'),
      header: [
        { id: 'date', title: 'DATE' },
        { id: 'timestamp', title: 'TIMESTAMP' },
        { id: 'totalTrades', title: 'TOTAL_TRADES' },
        { id: 'winningTrades', title: 'WINNING_TRADES' },
        { id: 'losingTrades', title: 'LOSING_TRADES' },
        { id: 'winRate', title: 'WIN_RATE' },
        { id: 'totalPnl', title: 'TOTAL_PNL' },
        { id: 'avgPnl', title: 'AVG_PNL' },
        { id: 'avgWin', title: 'AVG_WIN' },
        { id: 'avgLoss', title: 'AVG_LOSS' },
        { id: 'profitFactor', title: 'PROFIT_FACTOR' },
        { id: 'totalCommission', title: 'TOTAL_COMMISSION' },
        { id: 'totalSlippage', title: 'TOTAL_SLIPPAGE' },
        { id: 'netPnl', title: 'NET_PNL' },
        { id: 'balance', title: 'BALANCE' },
        { id: 'totalScans', title: 'TOTAL_SCANS' },
        { id: 'totalSignals', title: 'TOTAL_SIGNALS' },
        { id: 'totalExecutions', title: 'TOTAL_EXECUTIONS' },
      ],
      append: true,
    });

    const now = Date.now();
    const date = new Date(now).toLocaleDateString('ru-RU');
    const netPnl = stats.totalPnl - stats.totalCommission - stats.totalSlippage;

    const record: DailyStatsEntry = {
      date,
      timestamp: now,
      totalTrades: stats.totalTrades,
      winningTrades: stats.winningTrades,
      losingTrades: stats.losingTrades,
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      avgPnl: stats.avgPnl,
      avgWin: stats.avgWin,
      avgLoss: stats.avgLoss,
      profitFactor: stats.profitFactor,
      totalCommission: stats.totalCommission,
      totalSlippage: stats.totalSlippage,
      netPnl,
      balance,
      totalScans,
      totalSignals,
      totalExecutions,
    };

    csvWriter.writeRecords([record]);
    logger.info(`Logged daily stats: ${stats.totalTrades} trades, ${stats.winRate * 100}% win rate, $${netPnl} net PnL`);
  } catch (error) {
    logger.error('Error logging daily stats:', error);
  }
}
