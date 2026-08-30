import { PaperOrder, PaperPosition, TradeResult } from './types';
import { Signal } from '../signals/types';
import { OrderBook } from '../mexc/types';
import { createPaperOrder, simulateOrderFill, calculateExitPrice, shouldExitPosition, calculateTradeResult } from './orders';
import { config } from '../config';
import { logger } from '../utils/logger';
import { logPosition, logTrade } from '../storage/csv';

export interface PositionTracking {
  position: PaperPosition;
  highestUnrealizedPnl: number;
  lowestUnrealizedPnl: number;
  lastUpdate: number;
  partialExitDone: boolean;
  trailingActive: boolean;
  trailingStop?: number;
}

export interface CooldownInfo {
  until: number;
  reason: 'LOSS' | 'PROFIT';
}

export class PaperExecutor {
  private orders: PaperOrder[] = [];
  private positions: Map<string, PositionTracking> = new Map();
  private tradeResults: TradeResult[] = [];
  private balance: number = 100;
  private reservedBalance: number = 0;
  private totalScans: number = 0;
  private totalSignals: number = 0;
  private totalExecutions: number = 0;
  private positionSnapshots: Map<string, PaperPosition[]> = new Map();
  private orderBooks: Map<string, OrderBook> = new Map();
  private cooldowns: Map<string, CooldownInfo> = new Map();

  public cacheOrderbook(symbol: string, orderbook: OrderBook): void {
    this.orderBooks.set(symbol, orderbook);
  }

  public getLastOrderbook(symbol: string): OrderBook | null {
    return this.orderBooks.get(symbol) || null;
  }

  public isOnCooldown(symbol: string): boolean {
    const cooldown = this.cooldowns.get(symbol);
    if (!cooldown) return false;
    
    if (Date.now() >= cooldown.until) {
      this.cooldowns.delete(symbol);
      return false;
    }
    
    return true;
  }

  public hasOpenPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  public executeSignal(signal: Signal, orderbook: OrderBook): PaperOrder | null {
    if (this.hasOpenPosition(signal.symbol)) {
      logger.debug(`Position already open for ${signal.symbol}, skipping`);
      return null;
    }

    if (this.isOnCooldown(signal.symbol)) {
      const cooldown = this.cooldowns.get(signal.symbol)!;
      const remaining = Math.round((cooldown.until - Date.now()) / 1000);
      logger.debug(`Cooldown for ${signal.symbol}: ${remaining}s remaining (reason: ${cooldown.reason})`);
      return null;
    }

    const positionValue = this.balance * (config.positionSizePct / 100);
    const size = positionValue / signal.entry;

    if (size <= 0) {
      logger.warn(`Invalid size for ${signal.symbol}: ${size}`);
      return null;
    }

    if (this.positions.size >= config.maxPositions) {
      logger.warn(`Max positions reached: ${this.positions.size}`);
      return null;
    }

    const freeBalance = this.balance - this.reservedBalance;
    if (positionValue > freeBalance) {
      logger.warn(`Insufficient balance for ${signal.symbol}: need ${positionValue}$, have ${freeBalance}$`);
      return null;
    }

    const order = createPaperOrder(signal, size);
    const filledOrder = simulateOrderFill(order, orderbook);

    if (!filledOrder) {
      logger.info(`Order not filled for ${signal.symbol} at ${signal.entry}`);
      return null;
    }

    this.orders.push(filledOrder);
    this.totalSignals++;
    this.totalExecutions++;
    this.reservedBalance += positionValue;

    const position: PaperPosition = {
      symbol: signal.symbol,
      side: signal.side,
      size: filledOrder.size,
      entryPrice: filledOrder.avgFillPrice,
      currentPrice: filledOrder.avgFillPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
      signal,
      openTimestamp: Date.now(),
      strategyType: signal.type,
    };

    this.positions.set(signal.symbol, {
      position,
      highestUnrealizedPnl: 0,
      lowestUnrealizedPnl: 0,
      lastUpdate: Date.now(),
      partialExitDone: false,
      trailingActive: false,
      trailingStop: undefined,
    });

    this.positionSnapshots.set(signal.symbol, [position]);

    logger.info(`Opened position: ${signal.side} ${size} ${signal.symbol} at ${filledOrder.avgFillPrice}`);

    return filledOrder;
  }

  public updatePositions(orderbook: OrderBook, symbol: string): TradeResult | null {
    const tracking = this.positions.get(symbol);
    if (!tracking) {
      return null;
    }

    const position = tracking.position;
    
    // ✅ Добавлено логирование orderbook
    logger.debug(`[${symbol}] OB: bid=${orderbook.bids[0].price}, ask=${orderbook.asks[0].price}, ts=${Date.now()}`);
    
    const currentPrice = position.side === 'BUY' ? orderbook.bids[0].price : orderbook.asks[0].price;
    position.currentPrice = currentPrice;
    position.unrealizedPnl = (currentPrice - position.entryPrice) * position.size * (position.side === 'BUY' ? 1 : -1);

    if (position.unrealizedPnl > tracking.highestUnrealizedPnl) {
      tracking.highestUnrealizedPnl = position.unrealizedPnl;
    }
    if (position.unrealizedPnl < tracking.lowestUnrealizedPnl) {
      tracking.lowestUnrealizedPnl = position.unrealizedPnl;
    }

    tracking.lastUpdate = Date.now();

    const snapshots = this.positionSnapshots.get(symbol) || [];
    snapshots.push({ ...position });
    this.positionSnapshots.set(symbol, snapshots);

    logPosition(position);

    // ✅ Time-based exit: закрываем через N минут, если цена не пошла в пользу
    const maxHoldMinutes = config.maxHoldMinutes || 10;
    const holdMinutes = (Date.now() - position.openTimestamp) / 1000 / 60;

    if (holdMinutes > maxHoldMinutes && position.unrealizedPnl < 0) {
      logger.info(`Time-based exit for ${symbol}: held ${holdMinutes.toFixed(1)} min > ${maxHoldMinutes} min, PnL=${position.unrealizedPnl.toFixed(2)}`);
      const exitPrice = calculateExitPrice(position, orderbook);
      const result = calculateTradeResult(position, exitPrice);
      
      this.tradeResults.push(result);
      this.positions.delete(symbol);
      this.positionSnapshots.delete(symbol);
      this.balance += result.pnl;
      this.reservedBalance -= position.entryPrice * position.size;

      // ✅ Cooldown после любой сделки (15 минут)
      this.cooldowns.set(symbol, {
        until: Date.now() + 15 * 60 * 1000,
        reason: result.pnl >= 0 ? 'PROFIT' : 'LOSS',
      });
      logger.info(`Cooldown set for ${symbol}: 15 minutes after ${result.pnl >= 0 ? 'PROFIT' : 'LOSS'}`);

      const avgHoldTime = this.tradeResults.length > 0
        ? this.tradeResults.reduce((sum, t) => sum + (t.closeTimestamp - t.openTimestamp) / 1000 / 60, 0) / this.tradeResults.length
        : holdMinutes;

      logTrade(result, 'TIME_EXIT', tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);
      logger.info(`Closed position: ${symbol} | PnL: ${result.pnl} (${result.pnlPct}%) | Exit: TIME_EXIT`);

      return result;
    }

    // ✅ Трейлинг-стоп после TP1 (уменьшена дистанция: 0.2 ATR)
    const targetPnl1 = position.size * position.signal.atr * config.tpPct1;
    if (position.unrealizedPnl >= targetPnl1 && !tracking.trailingActive) {
      tracking.trailingActive = true;
      // ✅ Увеличено: 0.2 ATR вместо 0.15
      tracking.trailingStop = position.side === 'BUY'
        ? position.entryPrice + position.signal.atr * 0.2
        : position.entryPrice - position.signal.atr * 0.2;
      logger.info(`Trailing stop activated for ${symbol}: ${tracking.trailingStop.toFixed(4)} (0.2 ATR)`);
    }

    // Проверка трейлинг-стопа
    if (tracking.trailingActive && tracking.trailingStop) {
      const hitTrailingStop = position.side === 'BUY'
        ? currentPrice <= tracking.trailingStop
        : currentPrice >= tracking.trailingStop;

      if (hitTrailingStop) {
        logger.info(`Trailing stop hit for ${symbol} at ${currentPrice.toFixed(4)}`);
        const exitPrice = calculateExitPrice(position, orderbook);
        const result = calculateTradeResult(position, exitPrice);
        
        this.tradeResults.push(result);
        this.positions.delete(symbol);
        this.positionSnapshots.delete(symbol);
        this.balance += result.pnl;
        this.reservedBalance -= position.entryPrice * position.size;

        // ✅ Cooldown после любой сделки (15 минут)
        this.cooldowns.set(symbol, {
          until: Date.now() + 15 * 60 * 1000,
          reason: result.pnl >= 0 ? 'PROFIT' : 'LOSS',
        });
        logger.info(`Cooldown set for ${symbol}: 15 minutes after ${result.pnl >= 0 ? 'PROFIT' : 'LOSS'}`);

        const avgHoldTime = this.tradeResults.length > 0
          ? this.tradeResults.reduce((sum, t) => sum + (t.closeTimestamp - t.openTimestamp) / 1000 / 60, 0) / this.tradeResults.length
          : (Date.now() - position.openTimestamp) / 1000 / 60;

        logTrade(result, 'TRAILING', tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);
        logger.info(`Closed position: ${symbol} | PnL: ${result.pnl} (${result.pnlPct}%) | Exit: TRAILING`);

        return result;
      }
    }

    // ✅ Частичная фиксация на TP1 (50% позиции)
    const targetPnl1Full = position.size * position.signal.atr * config.tpPct1;

    if (!tracking.partialExitDone && position.unrealizedPnl >= targetPnl1Full) {
      tracking.partialExitDone = true;

      // Закрыть 50% позиции
      const partialSize = position.size * config.partialExitPct;
      const partialPnl = position.unrealizedPnl * config.partialExitPct;
      
      const partialTrade: TradeResult = {
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        size: partialSize,
        pnl: partialPnl,
        pnlPct: (currentPrice - position.entryPrice) / position.entryPrice * 100 * (position.side === 'BUY' ? 1 : -1),
        openTimestamp: position.openTimestamp,
        closeTimestamp: Date.now(),
        commission: 0,
        slippage: 0,
        setupType: position.signal.type,
      };

      this.tradeResults.push(partialTrade);
      position.realizedPnl += partialPnl;
      position.size *= (1 - config.partialExitPct);
      this.reservedBalance -= position.entryPrice * partialSize;

      logger.info(`Partial exit for ${symbol}: closed ${partialSize.toFixed(4)} (${config.partialExitPct * 100}%), PnL=${partialPnl.toFixed(2)}, remaining=${position.size.toFixed(4)}`);

      const avgHoldTime = this.tradeResults.length > 0
        ? this.tradeResults.reduce((sum, t) => sum + (t.closeTimestamp - t.openTimestamp) / 1000 / 60, 0) / this.tradeResults.length
        : (Date.now() - position.openTimestamp) / 1000 / 60;

      logTrade(partialTrade, 'TP1_PARTIAL', tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);
      
      // ✅ Возвращаем null — не проверяем TP2 в том же тике
      return null;
    }

    // ✅ Проверка TP2 — вычисляем targetPnl2Full после уменьшения size
    const targetPnl2Full = position.size * position.signal.atr * config.tpPct2;
    if (position.unrealizedPnl >= targetPnl2Full) {
      const exitPrice = calculateExitPrice(position, orderbook);
      const result = calculateTradeResult(position, exitPrice);

      this.tradeResults.push(result);
      this.positions.delete(symbol);
      this.positionSnapshots.delete(symbol);
      this.balance += result.pnl;
      this.reservedBalance -= position.entryPrice * position.size;

      // ✅ Cooldown после любой сделки (15 минут)
      this.cooldowns.set(symbol, {
        until: Date.now() + 15 * 60 * 1000,
        reason: result.pnl >= 0 ? 'PROFIT' : 'LOSS',
      });
      logger.info(`Cooldown set for ${symbol}: 15 minutes after ${result.pnl >= 0 ? 'PROFIT' : 'LOSS'}`);

      const avgHoldTime = this.tradeResults.length > 0
        ? this.tradeResults.reduce((sum, t) => sum + (t.closeTimestamp - t.openTimestamp) / 1000 / 60, 0) / this.tradeResults.length
        : (Date.now() - position.openTimestamp) / 1000 / 60;

      logTrade(result, 'TP2', tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);
      logger.info(`Closed position: ${symbol} | PnL: ${result.pnl} (${result.pnlPct}%) | Exit: TP2 | Size: ${position.size.toFixed(4)}`);

      return result;
    }

    // Проверка стоп-лосса
    const hitStop = shouldExitPosition(position, position.signal);
    if (hitStop) {
      const exitPrice = calculateExitPrice(position, orderbook);
      const result = calculateTradeResult(position, exitPrice);

      this.tradeResults.push(result);
      this.positions.delete(symbol);
      this.positionSnapshots.delete(symbol);
      this.balance += result.pnl;
      this.reservedBalance -= position.entryPrice * position.size;

      // ✅ Cooldown после любой сделки (15 минут)
      this.cooldowns.set(symbol, {
        until: Date.now() + 15 * 60 * 1000,
        reason: result.pnl >= 0 ? 'PROFIT' : 'LOSS',
      });
      logger.info(`Cooldown set for ${symbol}: 15 minutes after ${result.pnl >= 0 ? 'PROFIT' : 'LOSS'}`);

      const avgHoldTime = this.tradeResults.length > 0
        ? this.tradeResults.reduce((sum, t) => sum + (t.closeTimestamp - t.openTimestamp) / 1000 / 60, 0) / this.tradeResults.length
        : (Date.now() - position.openTimestamp) / 1000 / 60;

      logTrade(result, 'STOP', tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);
      logger.info(`Closed position: ${symbol} | PnL: ${result.pnl} (${result.pnlPct}%) | Exit: STOP`);

      return result;
    }

    return null;
  }

  public incrementScans(): void {
    this.totalScans++;
  }

  public getPositions(): PaperPosition[] {
    return Array.from(this.positions.values()).map(t => t.position);
  }

  public getTradeResults(): TradeResult[] {
    return this.tradeResults;
  }

  public getBalance(): number {
    return this.balance;
  }

  public getFreeBalance(): number {
    return this.balance - this.reservedBalance;
  }

  public getStats(): { totalTrades: number; winRate: number; totalPnl: number; avgPnl: number } {
    const totalTrades = this.tradeResults.length;
    const winningTrades = this.tradeResults.filter(t => t.pnl > 0).length;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    const totalPnl = this.tradeResults.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;

    return { totalTrades, winRate, totalPnl, avgPnl };
  }

  public getActivityStats(): { totalScans: number; totalSignals: number; totalExecutions: number } {
    return {
      totalScans: this.totalScans,
      totalSignals: this.totalSignals,
      totalExecutions: this.totalExecutions,
    };
  }
}
