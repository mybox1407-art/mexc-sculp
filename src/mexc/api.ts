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
      
      logger.info(`API response: ${response.data.data?.length || 0} contracts`);
      
      return response.data.data
        .filter((s: any) => {
          const isActive = s.state === 0 || s.state === 1;
          const isApiAllowed = s.apiAllowed !== false;
          const isUsdt = s.quoteCoin === 'USDT' || s.quote_currency === 'USDT';
          const isNotHidden = s.isHidden !== true;
          
          return isActive && isApiAllowed && isUsdt && isNotHidden;
        })
        .map((s: any) => ({
          symbol: s.symbol,
          baseAsset: s.baseCoin || s.base_asset,
          quoteAsset: s.quoteCoin || s.quote_currency,
          status: '1',
          minNotional: parseFloat(s.minVol || s.min_notional || '0'),
          minQty: parseFloat(s.minVol || s.min_notional || '0'),
          maxQty: parseFloat(s.limitMaxVol || s.max_vol || '0'),
          stepSize: Math.pow(10, -(s.volScale || 0)),
          tickSize: Math.pow(10, -(s.priceScale || 0)),
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

  async getCandles(symbol: string, _interval: string): Promise<Candle[]> {
    try {
      const response = await this.client.get(`/api/v1/contract/kline/${symbol}`, {
        params: { 
          interval: 'Min1',
        },
      });
      
      const data = response.data.data;
      
      const times = data.time || [];
      const opens = data.open || [];
      const highs = data.high || [];
      const lows = data.low || [];
      const closes = data.close || [];
      const vols = data.vol || [];
      const amounts = data.amount || [];
      
      return times.map((t: number, i: number) => ({
        symbol,
        openTime: t,
        open: parseFloat(opens[i]),
        high: parseFloat(highs[i]),
        low: parseFloat(lows[i]),
        close: parseFloat(closes[i]),
        volume: parseFloat(vols[i]),
        closeTime: t,
        quoteAssetVolume: parseFloat(amounts[i]),
        numberOfTrades: 0,
        takerBuyBaseAssetVolume: 0,
        takerBuyQuoteAssetVolume: 0,
      }));
    } catch (error: any) {
      if (error.response) {
        logger.error(`Candles API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      logger.error(`Error fetching candles for ${symbol}: ${getErrorMessage(error)}`);
      return [];
    }
  }
}
