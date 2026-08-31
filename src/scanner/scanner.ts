import { MexcApi } from '../mexc/api';
import { MexcWebSocket, OrderBookHandler, TradeHandler } from '../mexc/websocket';
import { OrderBook, Trade, Candle, Ticker24h, SymbolInfo } from '../mexc/types';
import { calculateDepth, calculateSpreadPct, calculateVolatilityMetrics } from './metrics';
import { detectWalls, detectVolumeMismatch, detectRevivalPattern, isTokenSupported } from './filter';
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
  private recentTradesWindowMs: number = 60000;
  private orderbookHistory: Map<string, OrderBook[]> = new Map();

  constructor() {
    this.mexcApi = new MexcApi();
    this.mexcWs = new MexcWebSocket();
  }

  public async start(): Promise<void> {
    logger.info('Starting scanner...');
    
    this.symbols = await this.mexcApi.getSymbols();
    logger.info(`Loaded ${this.symbols.length} symbols`);
    
    this.tickers = new Map((await this.mexcApi.getTickers24h()).map(t => [t.symbol, t]));
    logger.info(`Loaded ${this.tickers.size} tickers`);
    
    // Ждём подключения WS перед подписками
    await this.mexcWs.connect();
    logger.info('WebSocket connected');
    
    const usdtSymbols = this.symbols.filter(s => 
      s.quoteAsset === 'USDT' && 
      s.status === '1'
    );
    logger.info(`Filtered ${usdtSymbols.length} USDT trading symbols`);
    
    for (const symbol of usdtSymbols.slice(0, 100)) {
      this.subscribeToSymbol(symbol.symbol);
    }
    
    setInterval(() => this.scan(), config.scanIntervalMs);
  }

  private subscribeToSymbol(symbol: string): void {
    const orderBookHandler: OrderBookHandler = (orderbook) => {
      logger.debug(
        `[SCANNER_OB_UPDATE] ${symbol} ` +
        `bid=${orderbook.bids[0].price} ask=${orderbook.asks[0].price} ` +
        `ts=${orderbook.timestamp}`
      );

      this.orderbooks.set(symbol, orderbook);
      
      if (!this.orderbookHistory.has(symbol)) {
        this.orderbookHistory.set(symbol, []);
      }
      const history = this.orderbookHistory.get(symbol)!;
      history.push(orderbook);
      if (history.length > 20) {
        history.shift();
      }
    };
    
    const tradeHandler: TradeHandler = (trade) => {
      if (!this.trades.has(symbol)) {
        this.trades.set(symbol, []);
      }
      const trades = this.trades.get(symbol)!;
      trades.push(trade);
      if (trades.length > 100) {
        trades.shift();
      }
    };
    
    this.mexcWs.subscribeOrderBook(symbol, orderBookHandler);
    this.mexcWs.subscribeTrades(symbol, tradeHandler);
  }

  public async getOrderbookFromApi(symbol: string): Promise<OrderBook | null> {
    try {
      const url = `${config.mexcBaseUrl}/api/v1/contract/depth/${encodeURIComponent(symbol)}`;

      const response = await fetch(url);
      const rawText = await response.text();

      if (!response.ok) {
        return null;
      }

      const data = JSON.parse(rawText);

      const payload = data.data ?? data;
      const bidsRaw = payload?.bids;
      const asksRaw = payload?.asks;

      if (!Array.isArray(bidsRaw) || !Array.isArray(asksRaw)) {
        return null;
      }

      const orderbook: OrderBook = {
        symbol,
        bids: bidsRaw.map((row: any[]) => ({
          price: parseFloat(row[0]),
          size: parseFloat(row[2]),
        })),
        asks: asksRaw.map((row: any[]) => ({
          price: parseFloat(row[0]),
          size: parseFloat(row[2]),
        })),
        timestamp: Date.now(),
      };

      if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
        return null;
      }

      return orderbook;
    } catch (error) {
      return null;
    }
  }

  public async scan(): Promise<ScannedToken[]> {
    logger.info('Running scan...');
    
    this.tickers = new Map((await this.mexcApi.getTickers24h()).map(t => [t.symbol, t]));
    
    const results: ScannedToken[] = [];
    
    for (const [symbol, ticker] of this.tickers.entries()) {
      if (config.excludedTokens.includes(symbol)) {
        continue;
      }

      const orderbook = this.orderbooks.get(symbol);
      const trades = this.trades.get(symbol) || [];
      
      if (!orderbook) {
        continue;
      }
      
      const depthMetrics = calculateDepth(orderbook, 5);
      const spreadPct = calculateSpreadPct(orderbook);
      
      if (depthMetrics.totalDepth < config.minLiquidityDepth) {
        continue;
      }

      if (spreadPct > config.maxSpreadPct) {
        continue;
      }
      
      let candles: Candle[] = this.candles.get(symbol) || [];
      if (candles.length === 0) {
        try {
          candles = await this.mexcApi.getCandles(symbol, '1m');
          this.candles.set(symbol, candles);
        } catch (error) {
          continue;
        }
      }
      
      const volMetrics = calculateVolatilityMetrics(candles, parseFloat(ticker.priceChangePercent));
      
      const wallResult = detectWalls(orderbook, 5);
      const volumeResult = detectVolumeMismatch(orderbook, trades, this.recentTradesWindowMs);
      const revivalPattern = detectRevivalPattern(this.orderbookHistory.get(symbol) || [], 10);
      
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
      
      if (volMetrics.atr < config.minAtr1m) {
        continue;
      }
      
      if (Math.abs(parseFloat(ticker.priceChangePercent)) < config.min24hChangePct) {
        continue;
      }
      
      results.push({
        symbol,
        depth: depthMetrics.totalDepth,
        spreadPct,
        atr: volMetrics.atr,
        change24hPct: parseFloat(ticker.priceChangePercent),
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
  }

  public getScannedTokens(): ScannedToken[] {
    return this.scannedTokens;
  }

  public getOrderbookFromCache(symbol: string): OrderBook | null {
    return this.orderbooks.get(symbol) || null;
  }

  public async refreshOrderbookFromApi(symbol: string): Promise<OrderBook | null> {
    const orderbook = await this.getOrderbookFromApi(symbol);
    
    if (orderbook && orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      this.orderbooks.set(symbol, orderbook);
      logger.info(`[SCANNER_OB_REFRESH] ${symbol}: bid=${orderbook.bids[0].price}, ask=${orderbook.asks[0].price}`);
    }
    
    return orderbook;
  }
}
