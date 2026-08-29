import axios, { AxiosInstance } from 'axios';
import { Ticker24h, SymbolInfo, Candle } from './types';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';

export class MexcApi {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.mexc.com',
      timeout: 10000,
    });
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    try {
      const response = await this.client.get('/api/v1/contract/detail');
      
      // Логирование для отладки
      logger.info(`API response: ${response.data.data?.length || 0} contracts`);
      if (response.data.data?.length > 0) {
        logger.info(`Sample: ${JSON.stringify(response.data.data[0])}`);
      }
      
      return response.data.data
        .filter((s: any) => {
          // Проверяем разные варианты USDT
          const isUsdt = s.quoteCoin === 'USDT' || 
                         s.quote_currency === 'USDT' || 
                         s.symbol?.includes('USDT');
          return isUsdt && (s.state === 1 || s.status === 'Enable');
        })
        .map((s: any) => ({
          symbol: s.symbol,
          baseAsset: s.baseCoin || s.base_asset,
          quoteAsset: s.quoteCoin || s.quote_currency,
          status: (s.state === 1 || s.status === 'Enable') ? '1' : '0',
          minNotional: parseFloat(s.minVol || s.min_notional || '0'),
          minQty: parseFloat(s.minVol || s.min_notional || '0'),
          maxQty: parseFloat(s.limitMaxVol || s.max_vol || '0'),
          stepSize: parseFloat(s.volScale || s.vol_scale || '0'),
          tickSize: parseFloat(s.priceScale || s.price_scale || '0'),
        }));
    } catch (error) {
      logger.error(`Error fetching symbols: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async getTickers24h(): Promise<Ticker24h[]> {
    try {
      const response = await this.client.get('/api/v1/contract/ticker');
      return response.data.data.map((t: any) => ({
        symbol: t.symbol,
        priceChange: t.riseFallValue || '0',
        priceChangePercent: t.riseFallRate || '0',
        weightedAvgPrice: t.fairPrice || '0',
        prevClosePrice: t.open_price || '0',
        lastPrice: t.last || '0',
        lastQty: '0',
        bidPrice: t.bid1 || '0',
        askPrice: t.ask1 || '0',
        openPrice: t.open_price || '0',
        highPrice: t.high24Price || '0',
        lowPrice: t.lower24Price || '0',
        volume: t.volume24 || '0',
        quoteVolume: t.amount24 || '0',
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
