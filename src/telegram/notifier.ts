import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Signal } from '../signals/types';
import { TradeResult } from '../executor/types';
import { Stats } from '../executor/stats';

const bot = new TelegramBot(config.telegramBotToken, { polling: false });

export function sendSignalAlert(signal: Signal): void {
  const message = `
🚀 **Signal Alert**

Symbol: ${signal.symbol}
Type: ${signal.type}
Side: ${signal.side}
Entry: ${signal.entry}
Target: ${signal.target}
Stop: ${signal.stop}
ATR: ${signal.atr}
Confidence: ${signal.confidence ? (signal.confidence * 100).toFixed(1) + '%' : 'N/A'}
Time: ${new Date(signal.timestamp).toLocaleString()}
  `.trim();

  bot.sendMessage(config.telegramChatId, message, { parse_mode: 'Markdown' }).catch(err => {
    logger.error('Error sending signal alert:', err);
  });
}

export function sendTradeAlert(trade: TradeResult): void {
  const emoji = trade.pnl >= 0 ? '✅' : '❌';
  const netPnl = trade.pnl - trade.commission - trade.slippage;
  const message = `
${emoji} **Trade Closed**

Symbol: ${trade.symbol}
Side: ${trade.side}
Entry: ${trade.entryPrice}
Exit: ${trade.exitPrice}
Size: ${trade.size}
Gross PnL: ${trade.pnl} (${trade.pnlPct}%)
Commission: ${trade.commission}
Slippage: ${trade.slippage}
Net PnL: ${netPnl}
Setup: ${trade.setupType}
Time: ${new Date(trade.closeTimestamp).toLocaleString()}
  `.trim();

  bot.sendMessage(config.telegramChatId, message, { parse_mode: 'Markdown' }).catch(err => {
    logger.error('Error sending trade alert:', err);
  });
}

export function sendDailyReport(stats: Stats, balance: number, activityStats: { totalScans: number; totalSignals: number; totalExecutions: number }): void {
  const message = `
📊 **Daily Report**

Balance: $${balance.toFixed(2)}

**Trades:**
Total Trades: ${stats.totalTrades}
Win Rate: ${(stats.winRate * 100).toFixed(1)}%
Total PnL: $${stats.totalPnl.toFixed(2)}
Avg PnL: $${stats.avgPnl.toFixed(2)}
Avg Win: $${stats.avgWin.toFixed(2)}
Avg Loss: $${stats.avgLoss.toFixed(2)}
Profit Factor: ${stats.profitFactor.toFixed(2)}
Total Commission: $${stats.totalCommission.toFixed(2)}
Total Slippage: $${stats.totalSlippage.toFixed(2)}
Net PnL: $${stats.netPnl.toFixed(2)}

**Activity:**
Total Scans: ${activityStats.totalScans}
Total Signals: ${activityStats.totalSignals}
Total Executions: ${activityStats.totalExecutions}

**By Setup Type:**
${Object.entries(stats.bySetupType).map(([type, data]) => `- ${type}: ${data.trades} trades, ${(data.winRate * 100).toFixed(1)}% win, $${data.avgPnl.toFixed(2)} avg, $${data.totalPnl.toFixed(2)} total`).join('\n')}
  `.trim();

  bot.sendMessage(config.telegramChatId, message, { parse_mode: 'Markdown' }).catch(err => {
    logger.error('Error sending daily report:', err);
  });
}

export function sendErrorAlert(error: string): void {
  const message = `
❌ **Error Alert**

${error}
Time: ${new Date().toLocaleString()}
  `.trim();

  bot.sendMessage(config.telegramChatId, message, { parse_mode: 'Markdown' }).catch(err => {
    logger.error('Error sending error alert:', err);
  });
}
