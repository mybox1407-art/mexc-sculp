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

    // ✅ Отдельный цикл обновления позиций (раз в 2 секунды) — по WS-стакану из кэша
    const positionUpdateInterval = config.positionUpdateIntervalMs || 2000;
    
    setInterval(async () => {
      const openPositions = executor.getPositions();
      
      if (openPositions.length === 0) {
        return;
      }

      logger.info(`📊 Open positions: ${openPositions.length}`);
      
      for (const position of openPositions) {
        // ✅ Берём текущий WS-стакан из кэша (последний дифф от MEXC)
        let orderbook = executor.getLastOrderbook(position.symbol);

        // ✅ Логируем проверку WS-стакана
        logger.info(
          `[UPDATE_OB_WS] ${position.symbol} ` +
          `wsOb=${orderbook ? 'present' : 'null'} ` +
          `bids=${orderbook?.bids?.length ?? 0} ` +
          `asks=${orderbook?.asks?.length ?? 0}`
        );

        // ✅ Fallback на REST только если WS полностью мёртвый
        if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
          logger.warn(`[UPDATE_OB_WS_DEAD] ${position.symbol} fetching REST fallback`);
          orderbook = await scanner.getOrderbookFromApi(position.symbol);

          if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
            logger.warn(`[UPDATE_OB_REST_DEAD] ${position.symbol} skipping update`);
            continue;
          }
        }

        executor.cacheOrderbook(position.symbol, orderbook);
        
        const result = executor.updatePositions(orderbook, position.symbol);
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

      // ✅ 2. Логирование открытых позиций (после обновления!)
      const updatedPositions = executor.getPositions();
      for (const pos of updatedPositions) {
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
    }, positionUpdateInterval);

    // ✅ Основной цикл (сканирование + исполнение сигналов)
    while (true) {
      const scanTime = Date.now();
      const scannedTokens = scanner.getScannedTokens();
      logger.info(`Scanned tokens: ${scannedTokens.length}`);
      executor.incrementScans();

      logScan(scannedTokens, scanTime);

      // ✅ 1. Кэшируем orderbook для всех токенов
      for (const token of scannedTokens) {
        executor.cacheOrderbook(token.symbol, token.orderbook);
      }

      // ✅ 2. Генерируем и исполняем сигналы
      for (const token of scannedTokens) {
        const signals = generateSignals(token.candles, token.orderbook, token.atr);

        for (const signal of signals) {
          if (executor.hasOpenPosition(signal.symbol)) {
            logger.debug(`Position already open for ${signal.symbol}, skipping signal`);
            continue;
          }
          
          if (executor.isOnCooldown(signal.symbol)) {
            logger.debug(`Cooldown active for ${signal.symbol}, skipping signal`);
            continue;
          }

          // ✅ Используем свежий orderbook для исполнения
          let orderbook = await scanner.getOrderbookFromApi(signal.symbol);

          // ✅ Логируем проверку REST-стакана перед исполнением
          logger.info(
            `[EXEC_OB_CHECK] ${signal.symbol} ` +
            `restOb=${orderbook ? 'present' : 'null'} ` +
            `bids=${orderbook?.bids?.length ?? 0} ` +
            `asks=${orderbook?.asks?.length ?? 0} ` +
            `bid0=${JSON.stringify(orderbook?.bids?.[0] ?? null)} ` +
            `ask0=${JSON.stringify(orderbook?.asks?.[0] ?? null)}`
          );

          // Если REST вернул null или пустую сторону — fallback на WebSocket
          if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
            logger.warn(`[EXEC_OB_FALLBACK] ${signal.symbol} using WebSocket fallback`);
            orderbook = token.orderbook;
          }

          const order = executor.executeSignal(signal, orderbook);

          // ✅ Логируем результат исполнения
          logSignal(signal, order !== null);

          if (!order) {
            logger.debug(`Signal not executed: ${signal.type} ${signal.symbol} ${signal.side}`);
            continue;
          }

          logger.info(`Executed signal: ${signal.type} ${signal.symbol} ${signal.side}`);
          
          const positionValue = order.size * order.avgFillPrice;
          
          logger.info(
            `📊 Before Telegram: Balance=${executor.getBalance().toFixed(2)}, ` +
            `Free=${executor.getFreeBalance().toFixed(2)}`
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

      // ✅ 3. Daily report
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
