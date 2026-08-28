import { Scanner } from './scanner/scanner';
import { PaperExecutor } from './executor/paper';
import { generateSignals } from './signals/generator';
import { initializeCsvFiles, logScan, logSignal } from './storage/csv';
import { calculateStats } from './executor/stats';
import { sendSignalAlert, sendTradeAlert, sendDailyReport, sendErrorAlert } from './telegram/notifier';
import { config } from './config';
import { logger } from './utils/logger';
import { sleep } from './utils/helpers';

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

    while (true) {
      const scannedTokens = scanner.getScannedTokens();
      logger.info(`Scanned tokens: ${scannedTokens.length}`);
      executor.incrementScans();

      logScan(scannedTokens, Date.now());

      for (const token of scannedTokens) {
        const signals = generateSignals(token.candles, token.orderbook, token.atr);

        for (const signal of signals) {
          logSignal(signal, true);
          sendSignalAlert(signal);
          const order = executor.executeSignal(signal, token.orderbook);

          if (order) {
            logger.info(`Executed signal: ${signal.type} ${signal.symbol} ${signal.side}`);
          }
        }

        const result = executor.updatePositions(token.orderbook, token.symbol);
        if (result) {
          sendTradeAlert(result);
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
    logger.error('Fatal error:', error);
    sendErrorAlert(`Fatal error: ${error}`);
    process.exit(1);
  }
}

main();
