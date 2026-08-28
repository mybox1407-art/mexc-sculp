export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function calculateMidPrice(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

export function calculateSpreadPct(bid: number, ask: number): number {
  return ((ask - bid) / bid) * 100;
}

export function formatNumber(num: number, decimals: number = 2): string {
  return num.toFixed(decimals);
}

export function getTimestamp(): number {
  return Date.now();
}
