import TelegramBot from 'node-telegram-bot-api';
import { Signal } from '../signals/types';
import { TradeResult } from '../executor/types';
import { config } from '../config';
import { logger } from '../utils/logger';

const bot = new TelegramBot(config.telegramBotToken);

export function sendSignalAlert(signal: Signal): void {
  const message = `
🚀 Signal Alert

Type: ${signal.type}
Symbol: ${signal.symbol}
Side: ${signal.side}
Entry: ${signal.entry}
Target: ${signal.target}
Stop: ${signal.stop}
ATR: ${signal.atr}
Confidence: ${(signal.confidence || 0) * 100}%
  `.trim();

  bot.sendMessage(config.telegramChatId, message).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Telegram error: ${message}`);
  });
}

export function sendTradeAlert(trade: TradeResult): void {
  const message = `
💰 Trade Alert

Symbol: ${trade.symbol}
Side: ${trade.side}
Entry: ${trade.entryPrice}
Exit: ${trade.exitPrice}
Size: ${trade.size}
PnL: ${trade.pnl} (${trade.pnlPct}%)
Setup: ${trade.setupType}
  `.trim();

  bot.sendMessage(config.telegramChatId, message).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Telegram error: ${message}`);
  });
}

export function sendDailyReport(stats: any, balance: number, activityStats: any): void {
  const message = `
📊 Daily Report

Total Trades: ${stats.totalTrades}
Win Rate: ${(stats.winRate * 100).toFixed(2)}%
Total PnL: $${stats.totalPnl.toFixed(2)}
Avg PnL: $${stats.avgPnl.toFixed(2)}
Profit Factor: ${stats.profitFactor.toFixed(2)}

Balance: $${balance.toFixed(2)}

Scans: ${activityStats.totalScans}
Signals: ${activityStats.totalSignals}
Executions: ${activityStats.totalExecutions}
  `.trim();

  bot.sendMessage(config.telegramChatId, message).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Telegram error: ${message}`);
  });
}

export function sendErrorAlert(errorMessage: string): void {
  const message = `
❌ Error Alert

${errorMessage}
  `.trim();

  bot.sendMessage(config.telegramChatId, message).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Telegram error: ${message}`);
  });
}
