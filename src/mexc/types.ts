export interface Ticker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  lastQty: string;
  bidPrice: string;
  askPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  firstId: number;
  lastId: number;
  count: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface Trade {
  id: number;
  price: number;
  qty: number;
  quoteQty: number;
  time: number;
  isBuyerMaker: boolean;
}

export interface Candle {
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteAssetVolume: number;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: number;
  takerBuyQuoteAssetVolume: number;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  minNotional: number;
  minQty: number;
  maxQty: number;
  stepSize: number;
  tickSize: number;
}

export type SignalType = 'VWAP_MEAN_REVERSION' | 'SPREAD_SCALP' | 'LIQUIDITY_SWEEP';

export type SignalSide = 'BUY' | 'SELL';

export interface Signal {
  type: SignalType;
  symbol: string;
  side: SignalSide;
  entry: number;
  target: number;
  stop: number;
  timestamp: number;
  atr: number;
  vwap?: number;
  confidence?: number;
}
