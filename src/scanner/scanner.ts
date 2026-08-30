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

  public async scan(): Promise<ScannedToken[]> {
    logger.info('Running scan...');
    
    this.tickers = new Map((await this.mexcApi.getTickers24h()).map(t => [t.symbol, t]));
    
    const results: ScannedToken[] = [];
    let totalWithOrderbook = 0;
    let totalWithDepth = 0;
    let totalWithCandles = 0;
    let totalSupported = 0;
    let totalAtr = 0;
    let totalChange24h = 0;
    let totalFiltered = 0;
    
    for (const [symbol, ticker] of this.tickers.entries()) {
      // ✅ Фильтр исключённых токенов
      if (config.excludedTokens.includes(symbol)) {
        logger.debug(`Excluded token: ${symbol}`);
        continue;
      }

      const orderbook = this.orderbooks.get(symbol);
      const trades = this.trades.get(symbol) || [];
      
      if (!orderbook) {
        continue;
      }
      totalWithOrderbook++;
      
      const depthMetrics = calculateDepth(orderbook, 5);
      const spreadPct = calculateSpreadPct(orderbook);
      
      // ✅ Фильтр по ликвидности: мин. $50k в стакане
      if (depthMetrics.totalDepth < config.minLiquidityDepth) {
        logger.debug(`Liquidity filter: ${symbol} depth=${depthMetrics.totalDepth.toFixed(2)} < ${config.minLiquidityDepth}`);
        totalFiltered++;
        continue;
      }
      totalWithDepth++;

      // ✅ Фильтр по спреду: макс. 0.5%
      if (spreadPct > config.maxSpreadPct) {
        logger.debug(`Spread filter: ${symbol} spread=${spreadPct.toFixed(2)}% > ${config.maxSpreadPct}%`);
        totalFiltered++;
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
      totalWithCandles++;
      
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
      totalSupported++;
      
      if (volMetrics.atr < config.minAtr1m) {
        continue;
      }
      totalAtr++;
      
      if (Math.abs(parseFloat(ticker.priceChangePercent)) < config.min24hChangePct) {
        continue;
      }
      totalChange24h++;
      
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
    logger.info(`Scan: ${totalWithOrderbook} orderbooks, ${totalWithDepth} depth>${config.minLiquidityDepth}, ${totalWithCandles} candles, ${totalSupported} supported, ${totalAtr} atr, ${totalChange24h} change24h, ${totalFiltered} filtered`);
    logger.info(`Scan complete: ${results.length} tokens matched`);
    
    return results;
  }

  public getScannedTokens(): ScannedToken[] {
    return this.scannedTokens;
  }
}
