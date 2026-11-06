import type { Alert, AssetType, NewAlert } from '../domain/alert.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, context?: Record<string, unknown>): void;
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
}

export interface Quote {
  symbol: string;
  price: number;
  timestamp: number | null;
  description?: string;
  currency?: string;
}

export interface CurrencyConversion {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  symbol: string;
  timestamp: number | null;
  description?: string;
  inverted: boolean;
}

export interface MarketDataWatcher {
  readonly closed: Promise<void>;
  stop(): Promise<void>;
}

export interface SymbolSuggestion {
  id: string;
  description: string;
  exchange: string;
  currency?: string;
}

export interface StockListPage {
  exchange: string;
  offset: number;
  symbols: SymbolSuggestion[];
  hasMore: boolean;
}

export interface MarketDataSource {
  getQuote(symbol: string): Promise<Quote>;
  getCurrencyQuote(baseCurrency: string, quoteCurrency: string): Promise<CurrencyConversion>;
  searchSymbols(query: string, assetType: AssetType): Promise<SymbolSuggestion[]>;
  listStocks(exchange: string, offset: number): Promise<StockListPage>;
  watchQuotes(
    symbols: readonly string[],
    handlers: {
      onQuote(quote: Quote): void;
      onError?(error: unknown): void;
    },
  ): Promise<MarketDataWatcher>;
}

export interface AlertRepository {
  create(input: NewAlert): Promise<Alert>;
  listByChat(chatId: string): Promise<Alert[]>;
  deleteByChatAndId(chatId: string, id: number): Promise<boolean>;
  listActiveSymbols(): Promise<string[]>;
  findActiveBySymbol(symbol: string): Promise<Alert[]>;
  claim(id: number, now: string): Promise<boolean>;
  markTriggered(id: number, triggeredAt: string): Promise<void>;
  releaseClaim(id: number): Promise<void>;
  releaseStaleClaims(before: string): Promise<void>;
}

export interface AlertNotifier {
  sendAlert(alert: Alert, quote: Quote): Promise<void>;
}

export interface AlertCreationInput {
  chatId: string;
  assetType: AssetType;
  symbol: string;
  direction: NewAlert['direction'];
  targetPrice: number;
}
