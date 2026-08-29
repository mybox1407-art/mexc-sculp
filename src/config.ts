import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  mexcApiKey: string;
  mexcApiSecret: string;
  mexcBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  logToCsv: boolean;
  csvOutputPath: string;
  scanIntervalMs: number;
  minDepthUsd: number;
  maxSpreadPct: number;
  minAtr1m: number;
  min24hChangePct: number;
  atrMultiple: number;
  tpPct1: number;
  tpPct2: number;
  slAtrMultiple: number;
  maxRiskPerTradePct: number;
  maxPositions: number;
  paperTrading: boolean;
  logLevel: string;
  logScannerDetails: boolean;
  logSignalDetails: boolean;
  logExecutionDetails: boolean;
}

export const config: Config = {
  mexcApiKey: process.env.MEXC_API_KEY || '',
  mexcApiSecret: process.env.MEXC_API_SECRET || '',
  mexcBaseUrl: process.env.MEXC_BASE_URL || 'https://contract.mexc.com',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  logToCsv: process.env.LOG_TO_CSV !== 'false',
  csvOutputPath: process.env.CSV_OUTPUT_PATH || './output',
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '60000', 10),
  minDepthUsd: parseFloat(process.env.MIN_DEPTH_USD || '2000'),
  maxSpreadPct: parseFloat(process.env.MAX_SPREAD_PCT || '0.5'),
  minAtr1m: parseFloat(process.env.MIN_ATR_1M || '0.001'),
  min24hChangePct: parseFloat(process.env.MIN_24H_CHANGE_PCT || '5'),
  atrMultiple: parseFloat(process.env.ATR_MULTIPLE || '1.5'),
  tpPct1: parseFloat(process.env.TP_PCT_1 || '0.2'),
  tpPct2: parseFloat(process.env.TP_PCT_2 || '0.4'),
  slAtrMultiple: parseFloat(process.env.SL_ATR_MULTIPLE || '2'),
  maxRiskPerTradePct: parseFloat(process.env.MAX_RISK_PER_TRADE_PCT || '1'),
  maxPositions: parseInt(process.env.MAX_POSITIONS || '5', 10),
  paperTrading: process.env.PAPER_TRADING !== 'false',
  logLevel: process.env.LOG_LEVEL || 'info',
  logScannerDetails: process.env.LOG_SCANNER_DETAILS === 'true',
  logSignalDetails: process.env.LOG_SIGNAL_DETAILS === 'true',
  logExecutionDetails: process.env.LOG_EXECUTION_DETAILS === 'true',
};
