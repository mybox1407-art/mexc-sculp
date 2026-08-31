import { PaperOrder, PaperPosition, TradeResult } from './types';
import { Signal } from '../signals/types';
import { OrderBook } from '../mexc/types';
import { createPaperOrder, simulateOrderFill, calculateExitPrice, shouldExitPosition, calculateTradeResult, getBestPrices } from './orders';
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
  private positionLocks: Map<string, number> = new Map();
  private dailyLoss: number = 0;
  private lastResetDate: string = new Date().toDateString();

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

  public shouldStopTrading(): boolean {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss = 0;
      this.lastResetDate = today;
      logger.info(`Daily loss reset to 0 (new day: ${today})`);
    }

    if (config.dailyLossLimit && this.dailyLoss >= config.dailyLossLimit) {
      logger.warn(`Daily loss limit reached: ${this.dailyLoss.toFixed(2)} >= ${config.dailyLossLimit}`);
      return true;
    }

    return false;
  }

  public executeSignal(signal: Signal, orderbook: OrderBook): PaperOrder | null {
    if (this.hasOpenPosition(signal.symbol)) {
      logger.debug(`❌ Position already open for ${signal.symbol}, skipping`);
      return null;
    }

    if (this.isOnCooldown(signal.symbol)) {
      const cooldown = this.cooldowns.get(signal.symbol)!;
      const remaining = Math.round((cooldown.until - Date.now()) / 1000);
      logger.debug(`⏱ Cooldown for ${signal.symbol}: ${remaining}s remaining (reason: ${cooldown.reason})`);
      return null;
    }

    const lastCloseTime = this.positionLocks.get(signal.symbol);
    if (lastCloseTime && Date.now() - lastCloseTime < 5000) {
      logger.debug(`🔒 Position for ${signal.symbol} just closed (${Date.now() - lastCloseTime}ms ago), skipping`);
      return null;
    }

    if (this.shouldStopTrading()) {
      logger.warn(`⛔ Trading stopped due to daily loss limit`);
      return null;
    }

    const freeBalance = this.getFreeBalance();
    const positionValue = freeBalance * (config.positionSizePct / 100);
    const size = positionValue / signal.entry;

    if (size <= 0) {
      logger.warn(`Invalid size for ${signal.symbol}: ${size}`);
      return null;
    }

    if (this.positions.size >= config.maxPositions) {
      logger.warn(`Max positions reached: ${this.positions.size}`);
      return null;
    }

    if (positionValue > freeBalance) {
      logger.warn(`Insufficient balance for ${signal.symbol}: need ${positionValue.toFixed(2)}$, have ${freeBalance.toFixed(2)}$`);
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
    this.positionLocks.delete(signal.symbol);

    const newFreeBalance = this.getFreeBalance();
    logger.info(`✅ Opened: ${signal.side} ${size.toFixed(4)} ${signal.symbol} at ${filledOrder.avgFillPrice.toFixed(4)} | Balance: ${this.balance.toFixed(2)}$, Reserved: ${this.reservedBalance.toFixed(2)}$, Free: ${newFreeBalance.toFixed(2)}$`);

    return filledOrder;
  }

  public updatePositions(orderbook: OrderBook, symbol: string): TradeResult | null {
    const tracking = this.positions.get(symbol);
    if (!tracking) {
      return null;
    }

    const position = tracking.position;
    
    // ✅ Используем getBestPrices вместо прямого доступа к bids[0]/asks[0]
    const prices = getBestPrices(orderbook);
    if (!prices) {
      logger.warn(`[${symbol}] Skipping update: invalid orderbook`);
      return null;
    }
    
    logger.debug(`[${symbol}] OB: bid=${prices.bestBid}, ask=${prices.bestAsk}, ts=${Date.now()}`);
    
    const currentPrice = position.side === 'BUY' ? prices.bestBid : prices.bestAsk;
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

    // === 1. Time-based exit ===
    const maxHoldMinutes = config.maxHoldMinutes || 10;
    const holdMinutes = (Date.now() - position.openTimestamp) / 1000 / 60;

    if (holdMinutes > maxHoldMinutes && position.unrealizedPnl < 0) {
      logger.info(`Time-based exit for ${symbol}: held ${holdMinutes.toFixed(1)} min > ${maxHoldMinutes} min, PnL=${position.unrealizedPnl.toFixed(2)}`);
      const exitPrice = calculateExitPrice(position, orderbook);

      if (exitPrice === null) {
        logger.warn(`Cannot close ${symbol} by TIME_EXIT: invalid orderbook`);
        return null;
      }

      const result = calculateTradeResult(position, exitPrice);
      
      this._closePosition(symbol, result, tracking, 'TIME_EXIT');
      return result;
    }

    // === 2. Trailing stop после TP1 ===
    const targetPrice1 = position.side === 'BUY'
      ? position.entryPrice + position.signal.atr * config.tpAtrMultiple1
      : position.entryPrice - position.signal.atr * config.tpAtrMultiple1;

    if (!tracking.trailingActive && this._hitTargetPrice(position, targetPrice1)) {
      tracking.trailingActive = true;
      tracking.trailingStop = position.side === 'BUY'
        ? position.entryPrice + position.signal.atr * 0.2
        : position.entryPrice - position.signal.atr * 0.2;
      logger.info(`Trailing stop activated for ${symbol}: ${tracking.trailingStop.toFixed(4)} (0.2 ATR)`);
    }

    if (tracking.trailingActive && tracking.trailingStop) {
      const hitTrailingStop = position.side === 'BUY'
        ? currentPrice <= tracking.trailingStop
        : currentPrice >= tracking.trailingStop;

      if (hitTrailingStop) {
        logger.info(`Trailing stop hit for ${symbol} at ${currentPrice.toFixed(4)}`);
        const exitPrice = calculateExitPrice(position, orderbook);

        if (exitPrice === null) {
          logger.warn(`Cannot close ${symbol} by TRAILING: invalid orderbook`);
          return null;
        }

        const result = calculateTradeResult(position, exitPrice);
        
        this._closePosition(symbol, result, tracking, 'TRAILING');
        return result;
      }
    }

    // === 3. Частичный выход на TP1 ===
    if (!tracking.partialExitDone && this._hitTargetPrice(position, targetPrice1)) {
      tracking.partialExitDone = true;

      const partialSize = position.size * config.partialExitPct;
      const partialPnl = (targetPrice1 - position.entryPrice) * partialSize * (position.side === 'BUY' ? 1 : -1);
      
      const partialTrade: TradeResult = {
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: targetPrice1,
        size: partialSize,
        pnl: partialPnl,
        pnlPct: (targetPrice1 - position.entryPrice) / position.entryPrice * 100 * (position.side === 'BUY' ? 1 : -1),
        openTimestamp: position.openTimestamp,
        closeTimestamp: Date.now(),
        commission: 0,
        slippage: 0,
        setupType: position.signal.type,
      };

      this.tradeResults.push(partialTrade);
      position.realizedPnl += partialPnl;
      
      const positionValueBefore = position.entryPrice * position.size;
      position.size *= (1 - config.partialExitPct);
      const positionValueAfter = position.entryPrice * position.size;
      this.reservedBalance -= (positionValueBefore - positionValueAfter);
      this.balance += partialPnl;

      logger.info(`Partial exit for ${symbol}: closed ${partialSize.toFixed(4)} (${config.partialExitPct * 100}%), PnL=${partialPnl.toFixed(2)}, remaining=${position.size.toFixed(4)} | Balance: ${this.balance.toFixed(2)}$, Reserved: ${this.reservedBalance.toFixed(2)}$`);

      const avgHoldTime = this._calculateAvgHoldTime();
      logTrade(partialTrade, 'TP1_PARTIAL', tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);
      
      return null;
    }

    // === 4. Выход на TP2 ===
    const targetPrice2 = position.side === 'BUY'
      ? position.entryPrice + position.signal.atr * config.tpAtrMultiple2
      : position.entryPrice - position.signal.atr * config.tpAtrMultiple2;

    if (this._hitTargetPrice(position, targetPrice2)) {
      const exitPrice = calculateExitPrice(position, orderbook);

      if (exitPrice === null) {
        logger.warn(`Cannot close ${symbol} by TP2: invalid orderbook`);
        return null;
      }

      const result = calculateTradeResult(position, exitPrice);
      
      this._closePosition(symbol, result, tracking, 'TP2');
      return result;
    }

    // === 5. Выход по STOP ===
    const hitStop = shouldExitPosition(position, position.signal);
    if (hitStop) {
      const exitPrice = calculateExitPrice(position, orderbook);

      if (exitPrice === null) {
        logger.warn(`Cannot close ${symbol} by STOP: invalid orderbook`);
        return null;
      }

      const result = calculateTradeResult(position, exitPrice);
      
      this._closePosition(symbol, result, tracking, 'STOP');
      return result;
    }

    return null;
  }

  private _hitTargetPrice(position: PaperPosition, targetPrice: number): boolean {
    return position.side === 'BUY'
      ? position.currentPrice >= targetPrice
      : position.currentPrice <= targetPrice;
  }

  private _closePosition(symbol: string, result: TradeResult, tracking: PositionTracking, exitReason: string): void {
    this.tradeResults.push(result);
    this.positions.delete(symbol);
    this.positionSnapshots.delete(symbol);
    
    const positionValueAtEntry = result.entryPrice * result.size;
    this.balance += result.pnl;
    this.reservedBalance -= positionValueAtEntry;
    
    if (result.pnl < 0) {
      this.dailyLoss += Math.abs(result.pnl);
      logger.info(`Daily loss updated: ${this.dailyLoss.toFixed(2)}$ (limit: ${config.dailyLossLimit || 'none'})`);
    }
    
    this.positionLocks.set(symbol, Date.now());

    this.cooldowns.set(symbol, {
      until: Date.now() + 15 * 60 * 1000,
      reason: result.pnl >= 0 ? 'PROFIT' : 'LOSS',
    });

    const avgHoldTime = this._calculateAvgHoldTime();
    logTrade(result, exitReason, tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);
    
    logger.info(`❌ Closed: ${symbol} | PnL: ${result.pnl.toFixed(2)}$ (${result.pnlPct.toFixed(2)}%) | Exit: ${exitReason} | Balance: ${this.balance.toFixed(2)}$, Reserved: ${this.reservedBalance.toFixed(2)}$, Free: ${this.getFreeBalance().toFixed(2)}$`);
  }

  private _calculateAvgHoldTime(): number {
    if (this.tradeResults.length === 0) return 0;
    return this.tradeResults.reduce((sum, t) => sum + (t.closeTimestamp - t.openTimestamp) / 1000 / 60, 0) / this.tradeResults.length;
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

  public getStats(): { totalTrades: number; winRate: number; totalPnl: number; avgPnl: number; avgWin: number; avgLoss: number; profitFactor: number; totalCommission: number; totalSlippage: number } {
    const totalTrades = this.tradeResults.length;
    const winningTrades = this.tradeResults.filter(t => t.pnl > 0).length;
    const losingTrades = this.tradeResults.filter(t => t.pnl <= 0).length;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    const totalPnl = this.tradeResults.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    
    const totalWins = this.tradeResults.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const totalLosses = Math.abs(this.tradeResults.filter(t => t.pnl <= 0).reduce((sum, t) => sum + t.pnl, 0));
    const avgWin = winningTrades > 0 ? totalWins / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLosses / losingTrades : 0;
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;
    
    const totalCommission = this.tradeResults.reduce((sum, t) => sum + t.commission, 0);
    const totalSlippage = this.tradeResults.reduce((sum, t) => sum + t.slippage, 0);

    return { totalTrades, winRate, totalPnl, avgPnl, avgWin, avgLoss, profitFactor, totalCommission, totalSlippage };
  }

  public getActivityStats(): { totalScans: number; totalSignals: number; totalExecutions: number } {
    return {
      totalScans: this.totalScans,
      totalSignals: this.totalSignals,
      totalExecutions: this.totalExecutions,
    };
  }
}
