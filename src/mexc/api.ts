import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { Ticker24h, SymbolInfo, Candle } from './types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';

export class MexcApi {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.mexcBaseUrl,  // https://contract.mexc.com
      timeout: 10000,
    });
  }

  // Подпись запроса
  private signQuery(params: Record<string, any>): string {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    
    const signature = crypto
      .createHmac('sha256', config.mexcApiSecret)
      .update(queryString)
      .digest('hex');
    
    return `${queryString}&signature=${signature}`;
  }

  // Заголовки с API ключом
  private getHeaders(): Record<string, string> {
    return {
      'Mexc-Api-Key': config.mexcApiKey,
    };
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    try {
      const response = await this.client.get('/api/v1/contract/list', {
        headers: this.getHeaders(),
      });
      return response.data.data.map((s: any) => ({
        symbol: s.symbol,
        baseAsset: s.base_currency,
        quoteAsset: s.quote_currency,
        status: s.status === 'Enable' ? '1' : '0',
        minNotional: parseFloat(s.min_leverage || '0'),
        minQty: parseFloat(s.min_vol || '0'),
        maxQty: parseFloat(s.max_vol || '0'),
        stepSize: parseFloat(s.vol_precision || '0'),
        tickSize: parseFloat(s.price_precision || '0'),
      }));
    } catch (error) {
      logger.error(`Error fetching symbols: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async getTickers24h(): Promise<Ticker24h[]> {
    try {
      const response = await this.client.get('/api/v1/contract/ticker/24hr', {
        headers: this.getHeaders(),
      });
      return response.data.data.map((t: any) => ({
        symbol: t.symbol,
        priceChange: t.change_rate || '0',
        priceChangePercent: t.change_rate || '0',
        weightedAvgPrice: t.mark_price || '0',
        prevClosePrice: t.open_price || '0',
        lastPrice: t.last || '0',
        lastQty: '0',
        bidPrice: t.bid || '0',
        askPrice: t.ask || '0',
        openPrice: t.open_price || '0',
        highPrice: t.high || '0',
        lowPrice: t.low || '0',
        volume: t.volume || '0',
        quoteVolume: t.amount || '0',
        openTime: 0,
        closeTime: 0,
        firstId: 0,
        lastId: 0,
        count: 0,
      }));
    } catch (error) {
      logger.error(`Error fetching 24h tickers: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async getCandles(symbol: string, interval: string, limit: number = 100): Promise<Candle[]> {
    try {
      const response = await this.client.get('/api/v1/contract/kline', {
        headers: this.getHeaders(),
        params: { symbol, interval: this.mapInterval(interval), limit },
      });
      return response.data.data.map((k: any[]) => ({
        symbol,
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
        quoteAssetVolume: parseFloat(k[6]),
        numberOfTrades: k[7],
        takerBuyBaseAssetVolume: 0,
        takerBuyQuoteAssetVolume: 0,
      }));
    } catch (error) {
      logger.error(`Error fetching candles for ${symbol}: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  private mapInterval(interval: string): string {
    const map: Record<string, string> = {
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '1h': '1h',
      '4h': '4h',
      '1d': '1d',
    };
    return map[interval] || '1m';
  }
}
