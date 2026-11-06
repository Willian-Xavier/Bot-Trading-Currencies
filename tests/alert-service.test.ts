import { describe, expect, it, vi } from 'vitest';
import { AlertService } from '../src/application/alert-service.js';
import type { AlertRepository, AlertNotifier, Logger, MarketDataSource, Quote } from '../src/application/ports.js';
import type { Alert } from '../src/domain/alert.js';

const quote: Quote = { symbol: 'NASDAQ:AAPL', price: 180, timestamp: null };
const alert: Alert = {
  id: 1, chatId: '10', assetType: 'stock', symbol: 'NASDAQ:AAPL', direction: 'buy', targetPrice: 180,
  status: 'active', createdAt: new Date().toISOString(), claimedAt: null, triggeredAt: null,
};

describe('AlertService', () => {
  it('delivers and marks a matching alert once', async () => {
    const repository = fakeRepository([alert]);
    const notifier: AlertNotifier = { sendAlert: vi.fn().mockResolvedValue(undefined) };
    const source: MarketDataSource = {
      getQuote: vi.fn().mockResolvedValue(quote),
      getCurrencyQuote: vi.fn(),
      searchSymbols: vi.fn().mockResolvedValue([]),
      listStocks: vi.fn().mockResolvedValue({ exchange: 'NASDAQ', offset: 0, symbols: [], hasMore: false }),
      watchQuotes: vi.fn(),
    };
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new AlertService(repository, source, notifier, logger);

    await service.onQuote(quote);
    await service.onQuote(quote);

    expect(notifier.sendAlert).toHaveBeenCalledTimes(1);
    expect(repository.markTriggered).toHaveBeenCalledTimes(1);
  });
});

function fakeRepository(alerts: Alert[]): AlertRepository {
  return {
    create: vi.fn(), listByChat: vi.fn(), deleteByChatAndId: vi.fn(), listActiveSymbols: vi.fn(),
    findActiveBySymbol: vi.fn(async () => alerts.filter((item) => item.status === 'active')),
    claim: vi.fn(async (id: number) => {
      const item = alerts.find((entry) => entry.id === id);
      if (!item || item.status !== 'active') return false;
      item.status = 'notifying';
      return true;
    }),
    markTriggered: vi.fn(async (id: number) => {
      const item = alerts.find((entry) => entry.id === id);
      if (item) item.status = 'triggered';
    }),
    releaseClaim: vi.fn(async () => {}), releaseStaleClaims: vi.fn(async () => {}),
  };
}
