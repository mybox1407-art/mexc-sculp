import TelegramBot from 'node-telegram-bot-api';
import { Signal } from '../signals/types';
import { TradeResult } from '../executor/types';
import { config } from '../config';
import { logger } from '../utils/logger';

const bot = new TelegramBot(config.telegramBotToken);

export function sendTradeOpenedAlert(
  signal: Signal,
  size: number,
  positionValue: number,
  balance: number,
  freeBalance: number,
  strategyType: string
): void {
  const slPct = ((signal.stop - signal.entry) / signal.entry * 100 * (signal.side === 'BUY' ? -1 : 1)).toFixed(2);
  const tpPct = ((signal.target - signal.entry) / signal.entry * 100 * (signal.side === 'BUY' ? 1 : -1)).toFixed(2);

  const message = `
✅ DEAL OPENED

Symbol: ${signal.symbol}
Side: ${signal.side}
Strategy: ${strategyType}
Entry: ${signal.entry.toFixed(4)}
Size: ${size.toFixed(2)} ${signal.symbol.split('_')[0]}
Value: ${positionValue.toFixed(2)} USDT

SL: ${signal.stop.toFixed(4)} (${slPct}%)
TP: ${signal.target.toFixed(4)} (${tpPct}%)

Balance: ${balance.toFixed(2)} USDT
Free: ${freeBalance.toFixed(2)} USDT
  `.trim();

  bot.sendMessage(config.telegramChatId, message).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Telegram error: ${message}`);
  });
}

export function sendTradeClosedAlert(
  trade: TradeResult,
  exitReason: string,
  balance: number,
  freeBalance: number
): void {
  const emoji = trade.pnl >= 0 ? '💰' : '❌';
  const pnlEmoji = trade.pnl >= 0 ? '✅' : '🔴';

  const message = `
${emoji} DEAL CLOSED

Symbol: ${trade.symbol}
Side: ${trade.side}
Strategy: ${trade.setupType}
Entry: ${trade.entryPrice.toFixed(4)} → Exit: ${trade.exitPrice.toFixed(4)}
Size: ${trade.size.toFixed(2)} ${trade.symbol.split('_')[0]}

${pnlEmoji} PnL: ${trade.pnl.toFixed(2)} USDT (${trade.pnlPct.toFixed(2)}%)
Exit: ${exitReason}

Balance: ${balance.toFixed(2)} USDT
Free: ${freeBalance.toFixed(2)} USDT
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
