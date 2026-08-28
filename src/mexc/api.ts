import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { Ticker24h, SymbolInfo, Candle } from './types';
import { config } from '../config';
import { logger } from '../utils/logger';

export class MexcApi {
  private client: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    this.client = axios.create({
      baseURL: config.mexcBaseUrl,
      timeout: 10000,
    });
    this.apiKey = config.mexcApiKey;
    this.apiSecret = config.mexcApiSecret;
  }

  private signQuery(params: Record<string, any>): string {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
    return `${queryString}&signature=${signature}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      'X-MEXC-APIKEY': this.apiKey,
    };
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    try {
      const response = await this.client.get('/api/v3/exchangeInfo');
      return response.data.symbols.map((s: any) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
        minNotional: parseFloat(s.minNotional || '0'),
        minQty: parseFloat(s.minQty || '0'),
        maxQty: parseFloat(s.maxQty || '0'),
        stepSize: parseFloat(s.stepSize || '0'),
        tickSize: parseFloat(s.tickSize || '0'),
      }));
    } catch (error) {
      logger.error('Error fetching symbols:', error);
      throw error;
    }
  }

  async getTickers24h(): Promise<Ticker24h[]> {
    try {
      const response = await this.client.get('/api/v3/ticker/24hr');
      return response.data.map((t: any) => ({
        symbol: t.symbol,
        priceChange: t.priceChange,
        priceChangePercent: t.priceChangePercent,
        weightedAvgPrice: t.weightedAvgPrice,
        prevClosePrice: t.prevClosePrice,
        lastPrice: t.lastPrice,
        lastQty: t.lastQty,
        bidPrice: t.bidPrice,
        askPrice: t.askPrice,
        openPrice: t.openPrice,
        highPrice: t.highPrice,
        lowPrice: t.lowPrice,
        volume: t.volume,
        quoteVolume: t.quoteVolume,
        openTime: t.openTime,
        closeTime: t.closeTime,
        firstId: t.firstId,
        lastId: t.lastId,
        count: t.count,
      }));
    } catch (error) {
      logger.error('Error fetching 24h tickers:', error);
      throw error;
    }
  }

  async getCandles(symbol: string, interval: string, limit: number = 100): Promise<Candle[]> {
    try {
      const response = await this.client.get('/api/v3/klines', {
        params: { symbol, interval, limit },
      });
      return response.data.map((k: any[]) => ({
        symbol,
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteAssetVolume: parseFloat(k[7]),
        numberOfTrades: k[8],
        takerBuyBaseAssetVolume: parseFloat(k[9]),
        takerBuyQuoteAssetVolume: parseFloat(k[10]),
      }));
    } catch (error) {
      logger.error(`Error fetching candles for ${symbol}:`, error);
      throw error;
    }
  }
}
