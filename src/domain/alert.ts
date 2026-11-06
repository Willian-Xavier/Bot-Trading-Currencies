export type AssetType = 'stock' | 'forex';
export type AlertDirection = 'buy' | 'sell';

export interface Alert {
  id: number;
  chatId: string;
  assetType: AssetType;
  symbol: string;
  direction: AlertDirection;
  targetPrice: number;
  status: 'active' | 'notifying' | 'triggered';
  createdAt: string;
  claimedAt: string | null;
  triggeredAt: string | null;
}

export interface NewAlert {
  chatId: string;
  assetType: AssetType;
  symbol: string;
  direction: AlertDirection;
  targetPrice: number;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function isValidTradingViewSymbol(symbol: string): boolean {
  return /^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/.test(normalizeSymbol(symbol));
}

export function isAlertTriggered(direction: AlertDirection, currentPrice: number, targetPrice: number): boolean {
  return direction === 'buy' ? currentPrice <= targetPrice : currentPrice >= targetPrice;
}

export function directionLabel(direction: AlertDirection): string {
  return direction === 'buy' ? 'compra (preço menor ou igual)' : 'venda (preço maior ou igual)';
}
