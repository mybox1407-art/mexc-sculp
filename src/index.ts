import { Scanner } from './scanner/scanner';
import { PaperExecutor } from './executor/paper';
import { generateSignals } from './signals/generator';
import { initializeCsvFiles, logScan, logSignal } from './storage/csv';
import { calculateStats } from './executor/stats';
import { sendTradeOpenedAlert, sendTradeClosedAlert, sendDailyReport, sendErrorAlert } from './telegram/notifier';
import { config } from './config';
import { logger } from './utils/logger';
import { sleep } from './utils/helpers';
import { getErrorMessage } from './utils/error';

async function main() {
  logger.info('Starting MEXC Scalper Bot...');

  try {
    initializeCsvFiles();

    const scanner = new Scanner();
    const executor = new PaperExecutor();

    await scanner.start();
    logger.info('Scanner started');

    let lastReportTime = Date.now();
    const reportInterval = 24 * 60 * 60 * 1000;
    const positionCheckInterval = 5000;  // 5 секунд

    // Мониторинг позиций каждые 5 секунд
    setInterval(() => {
      const openPositions = executor.getPositions();
      
      // Обновляем ВСЕ открытые позиции
      for (const position of openPositions) {
        const token = scanner.getScannedTokens().find(t => t.symbol === position.symbol);
        if (token) {
          const result = executor.updatePositions(token.orderbook, token.symbol);
          if (result) {
            let exitReason = 'UNKNOWN';
            const pnlPct = (result.exitPrice - result.entryPrice) / result.entryPrice * 100 * (result.side === 'BUY' ? 1 : -1);
            if (pnlPct >= config.tpPct2) {
              exitReason = 'TP2';
            } else if (pnlPct >= config.tpPct1) {
              exitReason = 'TP1';
            } else {
              exitReason = 'STOP';
            }
            
            sendTradeClosedAlert(
              result,
              exitReason,
              executor.getBalance(),
              executor.getFreeBalance()
            );
          }
        }
      }
      
      // Лог открытых позиций
      if (openPositions.length > 0) {
        logger.info(`📊 Open positions: ${openPositions.length}`);
        for (const pos of openPositions) {
          const pnlPct = (pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100 * (pos.side === 'BUY' ? 1 : -1);
          const pnl = pos.unrealizedPnl;
          const slDist = ((pos.signal.stop - pos.entryPrice) / pos.entryPrice * 100 * (pos.side === 'BUY' ? -1 : 1)).toFixed(2);
          const tpDist = ((pos.signal.target - pos.entryPrice) / pos.entryPrice * 100 * (pos.side === 'BUY' ? 1 : -1)).toFixed(2);
          
          logger.info(
            `${pos.symbol} | ${pos.side} | ` +
            `Entry: ${pos.entryPrice.toFixed(4)} → Current: ${pos.currentPrice.toFixed(4)} | ` +
            `PnL: ${pnl.toFixed(2)}$ (${pnlPct.toFixed(2)}%) | ` +
            `SL: ${slDist}% | TP: ${tpDist}%`
          );
        }
      } else {
        logger.info('📊 No open positions');
      }
    }, positionCheckInterval);

    while (true) {
      const scannedTokens = scanner.getScannedTokens();
      logger.info(`Scanned tokens: ${scannedTokens.length}`);
      executor.incrementScans();

      logScan(scannedTokens, Date.now());

      for (const token of scannedTokens) {
        const signals = generateSignals(token.candles, token.orderbook, token.atr);

        for (const signal of signals) {
          logSignal(signal, true);
          
          const order = executor.executeSignal(signal, token.orderbook);

          if (order) {
            logger.info(`Executed signal: ${signal.type} ${signal.symbol} ${signal.side}`);
            
            const positionValue = order.size * order.avgFillPrice;
            sendTradeOpenedAlert(
              signal,
              order.size,
              positionValue,
              executor.getBalance(),
              executor.getFreeBalance()
            );
          }
        }
      }

      if (Date.now() - lastReportTime >= reportInterval) {
        const stats = calculateStats(executor.getTradeResults());
        const activityStats = executor.getActivityStats();
        sendDailyReport(stats, executor.getBalance(), activityStats);
        lastReportTime = Date.now();
      }

      await sleep(config.scanIntervalMs);
    }
  } catch (error) {
    const errMessage = getErrorMessage(error);
    logger.error(`Fatal error: ${errMessage}`);
    sendErrorAlert(`Fatal error: ${errMessage}`);
    process.exit(1);
  }
}

main();
