import { Scanner } from './scanner/scanner';
import { PaperExecutor } from './executor/paper';
import { generateSignals } from './signals/generator';
import { initializeCsvFiles, logScan, logSignal } from './storage/csv';
import { calculateStats } from './executor/stats';
import {
  sendTradeOpenedAlert,
  sendTradeClosedAlert,
  sendDailyReport,
  sendErrorAlert,
} from './telegram/notifier';
import { config } from './config';
import { logger } from './utils/logger';
import { sleep } from './utils/helpers';
import { getErrorMessage } from './utils/error';

const ORDERBOOK_MAX_AGE_MS = 5_000;

function isValidOrderbook(
  orderbook: {
    bids: Array<{ price: number }>;
    asks: Array<{ price: number }>;
    timestamp: number;
  } | null
): orderbook is {
  bids: Array<{ price: number }>;
  asks: Array<{ price: number }>;
  timestamp: number;
} {
  if (
    !orderbook ||
    orderbook.bids.length === 0 ||
    orderbook.asks.length === 0
  ) {
    return false;
  }

  const bestBid = orderbook.bids[0]?.price;
  const bestAsk = orderbook.asks[0]?.price;

  if (
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk) ||
    bestBid <= 0 ||
    bestAsk <= 0 ||
    bestBid >= bestAsk
  ) {
    return false;
  }

  return true;
}

function isFreshOrderbook(
  orderbook: {
    timestamp: number;
  } | null
): boolean {
  if (!orderbook || !Number.isFinite(orderbook.timestamp)) {
    return false;
  }

  return Date.now() - orderbook.timestamp <= ORDERBOOK_MAX_AGE_MS;
}

function resolveExitReason(
  result: {
    side: 'BUY' | 'SELL';
    entryPrice: number;
    exitPrice: number;
  }
): string {
  const pnlPct =
    ((result.exitPrice - result.entryPrice) / result.entryPrice) *
    100 *
    (result.side === 'BUY' ? 1 : -1);

  if (pnlPct >= config.tpPct2) {
    return 'TP2';
  }

  if (pnlPct >= config.tpPct1) {
    return 'TP1';
  }

  return 'STOP';
}

async function main(): Promise<void> {
  logger.info('Starting MEXC Scalper Bot...');

  try {
    initializeCsvFiles();

    const scanner = new Scanner();
    const executor = new PaperExecutor();

    await scanner.start();
    logger.info('Scanner started');

    let lastReportTime = Date.now();
    const reportInterval = 24 * 60 * 60 * 1000;
    const positionUpdateInterval =
      config.positionUpdateIntervalMs || 2_000;

    let positionUpdateInProgress = false;

    setInterval(() => {
      void (async () => {
        if (positionUpdateInProgress) {
          return;
        }

        positionUpdateInProgress = true;

        try {
          const openPositions = executor.getPositions();

          if (openPositions.length === 0) {
            return;
          }

          for (const position of openPositions) {
            let orderbook = scanner.getOrderbookFromCache(position.symbol);

            if (!isValidOrderbook(orderbook) || !isFreshOrderbook(orderbook)) {
              orderbook = await scanner.getOrderbookFromApi(position.symbol);
            }

            if (!isValidOrderbook(orderbook)) {
              logger.warn(
                `[POSITION_ORDERBOOK_UNAVAILABLE] ${position.symbol}; update skipped`
              );
              continue;
            }

            executor.cacheOrderbook(position.symbol, orderbook);

            const result = executor.updatePositions(
              orderbook,
              position.symbol
            );

            if (!result) {
              continue;
            }

            sendTradeClosedAlert(
              result,
              resolveExitReason(result),
              executor.getBalance(),
              executor.getFreeBalance()
            );
          }

          for (const position of executor.getPositions()) {
            const pnlPct =
              ((position.currentPrice - position.entryPrice) /
                position.entryPrice) *
              100 *
              (position.side === 'BUY' ? 1 : -1);

            const stopDistancePct =
              ((position.signal.stop - position.entryPrice) /
                position.entryPrice) *
              100 *
              (position.side === 'BUY' ? -1 : 1);

            const targetDistancePct =
              ((position.signal.target - position.entryPrice) /
                position.entryPrice) *
              100 *
              (position.side === 'BUY' ? 1 : -1);

            logger.info(
              `${position.symbol} | ${position.side} | ` +
              `Entry: ${position.entryPrice.toFixed(4)} -> ` +
              `Current: ${position.currentPrice.toFixed(4)} | ` +
              `PnL: ${position.unrealizedPnl.toFixed(2)}$ ` +
              `(${pnlPct.toFixed(2)}%) | ` +
              `SL: ${stopDistancePct.toFixed(2)}% | ` +
              `TP: ${targetDistancePct.toFixed(2)}%`
            );
          }
        } catch (error) {
          logger.error(
            `Position update error: ${getErrorMessage(error)}`
          );
        } finally {
          positionUpdateInProgress = false;
        }
      })();
    }, positionUpdateInterval);

    while (true) {
      const scanTime = Date.now();
      const scannedTokens = scanner.getScannedTokens();

      executor.incrementScans();

      logger.info(`Scanned tokens: ${scannedTokens.length}`);

      logScan(scannedTokens, scanTime);

      for (const token of scannedTokens) {
        if (!isValidOrderbook(token.orderbook)) {
          continue;
        }

        const signals = generateSignals(
          token.candles,
          token.orderbook,
          token.atr
        );

        for (const signal of signals) {
          if (executor.hasOpenPosition(signal.symbol)) {
            logger.debug(
              `Position already open for ${signal.symbol}, signal skipped`
            );
            continue;
          }

          if (executor.isOnCooldown(signal.symbol)) {
            logger.debug(
              `Cooldown active for ${signal.symbol}, signal skipped`
            );
            continue;
          }

          let orderbook = await scanner.getOrderbookFromApi(signal.symbol);

          if (!isValidOrderbook(orderbook)) {
            const wsOrderbook = scanner.getOrderbookFromCache(signal.symbol);

            if (
              isValidOrderbook(wsOrderbook) &&
              isFreshOrderbook(wsOrderbook)
            ) {
              orderbook = wsOrderbook;
              logger.warn(
                `[EXEC_ORDERBOOK_WS_FALLBACK] ${signal.symbol}`
              );
            }
          }

          if (!isValidOrderbook(orderbook)) {
            logger.warn(
              `[EXEC_ORDERBOOK_UNAVAILABLE] ${signal.symbol}; signal skipped`
            );

            logSignal(signal, false);
            continue;
          }

          const order = executor.executeSignal(signal, orderbook);

          logSignal(signal, order !== null);

          if (!order) {
            continue;
          }

          const positionValue = order.size * order.avgFillPrice;

          logger.info(
            `Executed signal: ${signal.type} ${signal.symbol} ${signal.side}`
          );

          sendTradeOpenedAlert(
            signal,
            order.size,
            positionValue,
            executor.getBalance(),
            executor.getFreeBalance(),
            signal.type
          );
        }
      }

      if (Date.now() - lastReportTime >= reportInterval) {
        const stats = calculateStats(executor.getTradeResults());
        const activityStats = executor.getActivityStats();

        sendDailyReport(
          stats,
          executor.getBalance(),
          activityStats
        );

        lastReportTime = Date.now();
      }

      await sleep(config.scanIntervalMs);
    }
  } catch (error) {
    const message = getErrorMessage(error);

    logger.error(`Fatal error: ${message}`);
    sendErrorAlert(`Fatal error: ${message}`);

    process.exit(1);
  }
}

void main();
