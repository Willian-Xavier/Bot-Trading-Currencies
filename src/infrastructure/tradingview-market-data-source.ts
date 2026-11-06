import { getQuote, searchMarkets, watchQuotes } from '@mathieuc/tradingview/data';
import type { CurrencyConversion, Logger, MarketDataSource, MarketDataWatcher, Quote, StockListPage, SymbolSuggestion } from '../application/ports.js';
import type { AssetType } from '../domain/alert.js';

export interface TradingViewSourceOptions {
  session?: string;
  signature?: string;
  debug?: boolean;
}

export class TradingViewMarketDataSource implements MarketDataSource {
  constructor(
    private readonly options: TradingViewSourceOptions = {},
    private readonly logger: Logger,
  ) {}

  async getQuote(symbol: string): Promise<Quote> {
    const quote = await getQuote({ symbol, fields: ['lp', 'lp_time', 'description', 'currency_code'], ...this.connection() });
    const result = toQuote(symbol, quote);
    this.logger.info('market_quote_received', { symbol, price: result.price, currency: result.currency });
    return result;
  }

  async getCurrencyQuote(baseCurrency: string, quoteCurrency: string): Promise<CurrencyConversion> {
    const base = normalizeCurrency(baseCurrency);
    const quote = normalizeCurrency(quoteCurrency);
    if (base === quote) {
      const conversion = { baseCurrency: base, quoteCurrency: quote, rate: 1, symbol: `${base}/${quote}`, timestamp: null, inverted: false };
      this.logger.info('currency_conversion_received', { baseCurrency: base, quoteCurrency: quote, rate: conversion.rate, symbol: conversion.symbol, inverted: false });
      return conversion;
    }

    const direct = await this.findCurrencyPair(`${base}${quote}`);
    if (direct) {
      const value = toQuote(direct.id, direct.quote);
      const conversion = {
        baseCurrency: base,
        quoteCurrency: quote,
        rate: value.price,
        symbol: direct.id,
        timestamp: value.timestamp,
        description: value.description,
        inverted: false,
      };
      this.logger.info('currency_conversion_received', { baseCurrency: base, quoteCurrency: quote, rate: conversion.rate, symbol: conversion.symbol, inverted: false });
      return conversion;
    }

    const inverse = await this.findCurrencyPair(`${quote}${base}`);
    if (inverse) {
      const value = toQuote(inverse.id, inverse.quote);
      const conversion = {
        baseCurrency: base,
        quoteCurrency: quote,
        rate: 1 / value.price,
        symbol: inverse.id,
        timestamp: value.timestamp,
        description: value.description,
        inverted: true,
      };
      this.logger.info('currency_conversion_received', { baseCurrency: base, quoteCurrency: quote, rate: conversion.rate, symbol: conversion.symbol, inverted: true });
      return conversion;
    }
    throw new Error(`No currency pair available for ${base}/${quote}`);
  }

  async searchSymbols(query: string, assetType: AssetType): Promise<SymbolSuggestion[]> {
    const results = await searchMarkets(query, { type: assetType === 'stock' ? 'stock' : 'forex' });
    this.logger.info('market_symbol_search', { query, assetType, resultCount: results.length });
    return results.slice(0, 8).map((result) => ({
      id: result.id,
      description: result.description,
      exchange: result.exchange,
      currency: result.currency,
    }));
  }

  async listStocks(exchange: string, offset: number): Promise<StockListPage> {
    const pageSize = 20;
    const results = await searchMarkets('', { type: 'stock', exchange, offset });
    this.logger.info('stock_list_received', { exchange, offset, resultCount: results.length });
    return {
      exchange,
      offset,
      symbols: results.slice(0, pageSize).map(toSuggestion),
      hasMore: results.length > pageSize,
    };
  }

  async watchQuotes(
    symbols: readonly string[],
    handlers: { onQuote(quote: Quote): void; onError?(error: unknown): void },
  ): Promise<MarketDataWatcher> {
    const watcher = await watchQuotes({
      symbols,
      fields: ['lp', 'lp_time', 'description', 'currency_code'],
      timeoutMs: 30_000,
      ...this.connection(),
    }, {
      onData: (symbol, quote) => {
        if (typeof quote.lp !== 'number' || !Number.isFinite(quote.lp)) return;
        const current = toQuote(symbol, quote);
        this.logger.debug('market_quote_update', { symbol, price: current.price, timestamp: current.timestamp });
        handlers.onQuote(current);
      },
      onError: handlers.onError,
    });
    this.logger.info('market_watcher_connected', { symbolCount: symbols.length, symbols });
    return {
      closed: watcher.closed,
      stop: async () => {
        await watcher.stop();
        this.logger.info('market_watcher_stopped', { symbolCount: symbols.length });
      },
    };
  }

  private connection() {
    return {
      credentials: this.options.session && this.options.signature
        ? { session: this.options.session, signature: this.options.signature }
        : undefined,
      clientOptions: this.options.debug ? { debug: true } : undefined,
    };
  }

  private async findCurrencyPair(pair: string): Promise<{ id: string; quote: Record<string, unknown> } | undefined> {
    const results = await searchMarkets(pair, { type: 'forex' });
    const exact = results
      .filter((result) => result.symbol.toUpperCase() === pair)
      .sort((a, b) => pairFeedPriority(a.id) - pairFeedPriority(b.id));
    for (const result of exact) {
      try {
        const quote = await getQuote({ symbol: result.id, fields: ['lp', 'lp_time', 'description', 'currency_code'], ...this.connection() });
        return { id: result.id, quote };
      } catch {
        // Try the next available TradingView feed for the same pair.
      }
    }
    return undefined;
  }
}

function normalizeCurrency(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`Invalid currency code: ${value}`);
  return code;
}

function pairFeedPriority(symbol: string): number {
  if (symbol.startsWith('FX_IDC:')) return 0;
  if (symbol.startsWith('OANDA:')) return 1;
  if (symbol.startsWith('FXCM:')) return 2;
  return 3;
}

function toSuggestion(result: { id: string; description: string; exchange: string; currency?: string }): SymbolSuggestion {
  return {
    id: result.id,
    description: result.description,
    exchange: result.exchange,
    currency: result.currency,
  };
}

function toQuote(symbol: string, quote: Record<string, unknown>): Quote {
  if (typeof quote.lp !== 'number' || !Number.isFinite(quote.lp)) {
    throw new Error(`TradingView returned no price for ${symbol}`);
  }
  return {
    symbol,
    price: quote.lp,
    timestamp: typeof quote.lp_time === 'number' ? quote.lp_time : null,
    description: typeof quote.description === 'string' ? quote.description : undefined,
    currency: typeof quote.currency_code === 'string' ? quote.currency_code : undefined,
  };
}
