import { MexcApi } from '../mexc/api';
import {
  MexcWebSocket,
  OrderBookHandler,
  TradeHandler,
} from '../mexc/websocket';
import { OrderBook, Trade, Candle, Ticker24h, SymbolInfo } from '../mexc/types';
import {
  calculateDepth,
  calculateSpreadPct,
  calculateVolatilityMetrics,
} from './metrics';
import {
  detectWalls,
  detectVolumeMismatch,
  detectRevivalPattern,
  isTokenSupported,
} from './filter';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ScannedToken {
  symbol: string;
  depth: number;
  spreadPct: number;
  atr: number;
  change24hPct: number;
  hasWalls: boolean;
  hasVolumeMismatch: boolean;
  hasRevivalPattern: boolean;
  orderbook: OrderBook;
  trades: Trade[];
  candles: Candle[];
}

export class Scanner {
  private mexcApi: MexcApi;
  private mexcWs: MexcWebSocket;

  private symbols: SymbolInfo[] = [];
  private tickers: Map<string, Ticker24h> = new Map();
  private orderbooks: Map<string, OrderBook> = new Map();
  private trades: Map<string, Trade[]> = new Map();
  private candles: Map<string, Candle[]> = new Map();
  private scannedTokens: ScannedToken[] = [];
  private orderbookHistory: Map<string, OrderBook[]> = new Map();

  private recentTradesWindowMs = 60_000;
  private scanInProgress = false;

  constructor() {
    this.mexcApi = new MexcApi();
    this.mexcWs = new MexcWebSocket();
  }

  public async start(): Promise<void> {
    logger.info('Starting scanner...');

    this.symbols = await this.mexcApi.getSymbols();
    logger.info(`Loaded ${this.symbols.length} symbols`);

    this.tickers = new Map(
      (await this.mexcApi.getTickers24h()).map((ticker) => [
        ticker.symbol,
        ticker,
      ])
    );
    logger.info(`Loaded ${this.tickers.size} tickers`);

    await this.mexcWs.connect();
    logger.info('WebSocket connected');

    const usdtSymbols = this.symbols.filter(
      (symbol) =>
        symbol.quoteAsset === 'USDT' &&
        symbol.status === '1'
    );

    logger.info(`Filtered ${usdtSymbols.length} USDT trading symbols`);

    for (const symbolInfo of usdtSymbols.slice(0, 100)) {
      await this.subscribeToSymbol(symbolInfo.symbol);
    }

    void this.scan();

    setInterval(() => {
      void this.scan();
    }, config.scanIntervalMs);
  }

  private async subscribeToSymbol(symbol: string): Promise<void> {
    const normalizedSymbol = symbol.toUpperCase();

    const orderBookHandler: OrderBookHandler = (orderbook) => {
      /*
       * Не мутируем объект, полученный из WS-клиента.
       * Scanner хранит отдельный snapshot.
       */
      const snapshot: OrderBook = {
        symbol: normalizedSymbol,
        bids: orderbook.bids.map((level) => ({ ...level })),
        asks: orderbook.asks.map((level) => ({ ...level })),
        timestamp: orderbook.timestamp,
      };

      this.orderbooks.set(normalizedSymbol, snapshot);

      const history = this.orderbookHistory.get(normalizedSymbol) ?? [];
      history.push(snapshot);

      if (history.length > 20) {
        history.shift();
      }

      this.orderbookHistory.set(normalizedSymbol, history);
    };

    const tradeHandler: TradeHandler = (trade) => {
      const trades = this.trades.get(normalizedSymbol) ?? [];

      trades.push(trade);

      if (trades.length > 100) {
        trades.shift();
      }

      this.trades.set(normalizedSymbol, trades);
    };

    await this.mexcWs.subscribeOrderBook(normalizedSymbol, orderBookHandler);
    await this.mexcWs.subscribeTrades(normalizedSymbol, tradeHandler);
  }

  public async getOrderbookFromApi(symbol: string): Promise<OrderBook | null> {
    const normalizedSymbol = symbol.toUpperCase();

    try {
      const url =
        `${config.mexcBaseUrl}/api/v1/contract/depth/` +
        encodeURIComponent(normalizedSymbol);

      const response = await fetch(url);

      if (!response.ok) {
        logger.warn(
          `[REST_ORDERBOOK_ERROR] ${normalizedSymbol}: HTTP ${response.status}`
        );
        return null;
      }

      const data = await response.json();
      const payload = data?.data ?? data;

      const bidsRaw = payload?.bids;
      const asksRaw = payload?.asks;

      if (!Array.isArray(bidsRaw) || !Array.isArray(asksRaw)) {
        logger.warn(`[REST_ORDERBOOK_INVALID] ${normalizedSymbol}`);
        return null;
      }

      const bids = this.parseRestLevels(bidsRaw, 'bid');
      const asks = this.parseRestLevels(asksRaw, 'ask');

      if (bids.length === 0 || asks.length === 0) {
        return null;
      }

      if (bids[0].price >= asks[0].price) {
        logger.warn(
          `[REST_ORDERBOOK_CROSSED] ${normalizedSymbol}: ` +
          `bid=${bids[0].price} ask=${asks[0].price}`
        );
        return null;
      }

      return {
        symbol: normalizedSymbol,
        bids,
        asks,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.warn(
        `[REST_ORDERBOOK_FAILED] ${normalizedSymbol}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  public async scan(): Promise<ScannedToken[]> {
    if (this.scanInProgress) {
      return this.scannedTokens;
    }

    this.scanInProgress = true;

    try {
      logger.info('Running scan...');

      this.tickers = new Map(
        (await this.mexcApi.getTickers24h()).map((ticker) => [
          ticker.symbol,
          ticker,
        ])
      );

      const results: ScannedToken[] = [];

      for (const [symbol, ticker] of this.tickers.entries()) {
        if (config.excludedTokens.includes(symbol)) {
          continue;
        }

        const orderbook = this.getOrderbookFromCache(symbol);

        if (!orderbook) {
          continue;
        }

        // Стакан старше 5 секунд не используем для генерации новых сигналов.
        if (Date.now() - orderbook.timestamp > 5_000) {
          continue;
        }

        const trades = this.trades.get(symbol) ?? [];

        const depthMetrics = calculateDepth(orderbook, 5);
        const spreadPct = calculateSpreadPct(orderbook);

        if (depthMetrics.totalDepth < config.minLiquidityDepth) {
          continue;
        }

        if (spreadPct > config.maxSpreadPct) {
          continue;
        }

        let candles = this.candles.get(symbol) ?? [];

        if (candles.length === 0) {
          candles = await this.mexcApi.getCandles(symbol, '1m');

          if (candles.length === 0) {
            continue;
          }

          this.candles.set(symbol, candles);
        }

        const change24hPct = Number(ticker.priceChangePercent);

        if (!Number.isFinite(change24hPct)) {
          continue;
        }

        const volatilityMetrics = calculateVolatilityMetrics(
          candles,
          change24hPct
        );

        if (!Number.isFinite(volatilityMetrics.atr)) {
          continue;
        }

        if (volatilityMetrics.atr < config.minAtr1m) {
          continue;
        }

        if (Math.abs(change24hPct) < config.min24hChangePct) {
          continue;
        }

        const wallResult = detectWalls(orderbook, 5);
        const volumeResult = detectVolumeMismatch(
          orderbook,
          trades,
          this.recentTradesWindowMs
        );
        const revivalPattern = detectRevivalPattern(
          this.orderbookHistory.get(symbol) ?? [],
          10
        );

        const isSupported = isTokenSupported(
          depthMetrics,
          spreadPct,
          wallResult,
          volumeResult,
          revivalPattern,
          config.minDepthUsd,
          config.maxSpreadPct
        );

        if (!isSupported) {
          continue;
        }

        results.push({
          symbol,
          depth: depthMetrics.totalDepth,
          spreadPct,
          atr: volatilityMetrics.atr,
          change24hPct,
          hasWalls: wallResult.hasWalls,
          hasVolumeMismatch: volumeResult.hasMismatch,
          hasRevivalPattern: revivalPattern,
          orderbook,
          trades,
          candles,
        });
      }

      this.scannedTokens = results;

      logger.info(`Scan complete: ${results.length} tokens matched`);

      return results;
    } catch (error) {
      logger.error(
        `Scanner error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      return this.scannedTokens;
    } finally {
      this.scanInProgress = false;
    }
  }

  public getScannedTokens(): ScannedToken[] {
    return this.scannedTokens;
  }

  public getOrderbookFromCache(symbol: string): OrderBook | null {
    const orderbook = this.orderbooks.get(symbol.toUpperCase());

    if (!orderbook) {
      return null;
    }

    if (
      orderbook.bids.length === 0 ||
      orderbook.asks.length === 0 ||
      orderbook.bids[0].price >= orderbook.asks[0].price
    ) {
      return null;
    }

    return orderbook;
  }

  public async refreshOrderbookFromApi(
    symbol: string
  ): Promise<OrderBook | null> {
    const normalizedSymbol = symbol.toUpperCase();
    const orderbook = await this.getOrderbookFromApi(normalizedSymbol);

    if (orderbook) {
      this.orderbooks.set(normalizedSymbol, orderbook);
    }

    return orderbook;
  }

  private parseRestLevels(
    rows: unknown[],
    side: 'bid' | 'ask'
  ): Array<{ price: number; size: number }> {
    const levels: Array<{ price: number; size: number }> = [];

    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) {
        continue;
      }

      const price = Number(row[0]);

      /*
       * Futures REST часто содержит [price, ..., size].
       * На случай формата [price, size] используем второй элемент.
       */
      const size = Number(row.length >= 3 ? row[2] : row[1]);

      if (
        !Number.isFinite(price) ||
        !Number.isFinite(size) ||
        price <= 0 ||
        size <= 0
      ) {
        continue;
      }

      levels.push({ price, size });
    }

    levels.sort(
      side === 'bid'
        ? (a, b) => b.price - a.price
        : (a, b) => a.price - b.price
    );

    return levels.slice(0, 100);
  }
}
