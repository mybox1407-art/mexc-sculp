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
  private orderBooks: Map<string, OrderBook> = new Map();  // ✅ Кэш orderbook

  // ✅ Кэширование orderbook
  public cacheOrderbook(symbol: string, orderbook: OrderBook): void {
    this.orderBooks.set(symbol, orderbook);
  }

  // ✅ Получение последнего orderbook
  public getLastOrderbook(symbol: string): OrderBook | null {
    return this.orderBooks.get(symbol) || null;
  }

  public executeSignal(signal: Signal, orderbook: OrderBook): PaperOrder | null {
    const positionValue = this.balance * (config.positionSizePct / 100);  // 30% от баланса
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
    };

    this.positions.set(signal.symbol, {
      position,
      highestUnrealizedPnl: 0,
      lowestUnrealizedPnl: 0,
      lastUpdate: Date.now(),
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

    if (shouldExitPosition(position, position.signal)) {
      const exitPrice = calculateExitPrice(position, orderbook);
      const result = calculateTradeResult(position, exitPrice);

      let exitReason = 'UNKNOWN';
      const pnlPct = (position.currentPrice - position.entryPrice) / position.entryPrice * 100 * (position.side === 'BUY' ? 1 : -1);
      if (pnlPct >= config.tpPct2) {
        exitReason = 'TP2';
      } else if (pnlPct >= config.tpPct1) {
        exitReason = 'TP1';
      } else {
        exitReason = 'STOP';
      }

      const durationMinutes = (Date.now() - position.openTimestamp) / 1000 / 60;
      const avgHoldTime = this.tradeResults.length > 0
        ? this.tradeResults.reduce((sum, t) => sum + (t.closeTimestamp - t.openTimestamp) / 1000 / 60, 0) / this.tradeResults.length
        : durationMinutes;

      this.tradeResults.push(result);
      this.positions.delete(symbol);
      this.positionSnapshots.delete(symbol);
      this.balance += result.pnl;
      this.reservedBalance -= position.entryPrice * position.size;

      logTrade(result, exitReason, tracking.highestUnrealizedPnl, tracking.lowestUnrealizedPnl, avgHoldTime);

      logger.info(`Closed position: ${symbol} | PnL: ${result.pnl} (${result.pnlPct}%) | Exit: ${exitReason}`);

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
