import {
  isAlertTriggered,
  normalizeSymbol,
  type NewAlert,
} from '../domain/alert.js';
import type { AlertCreationInput, AlertNotifier, AlertRepository, Logger, MarketDataSource, Quote } from './ports.js';

export class AlertService {
  constructor(
    private readonly repository: AlertRepository,
    private readonly marketData: MarketDataSource,
    private readonly notifier: AlertNotifier,
    private readonly logger: Logger,
  ) {}

  async create(input: AlertCreationInput): Promise<Awaited<ReturnType<AlertRepository['create']>>> {
    const symbol = normalizeSymbol(input.symbol);
    const quote = await this.marketData.getQuote(symbol);
    if (!Number.isFinite(quote.price) || quote.price <= 0) {
      throw new Error(`No valid price was returned for ${symbol}`);
    }
    const alert = await this.repository.create({ ...input, symbol });
    this.logger.info('alert_created', { alertId: alert.id, symbol: alert.symbol, direction: alert.direction, targetPrice: alert.targetPrice });
    return alert;
  }

  list(chatId: string): ReturnType<AlertRepository['listByChat']> {
    return this.repository.listByChat(chatId);
  }

  delete(chatId: string, id: number): ReturnType<AlertRepository['deleteByChatAndId']> {
    return this.repository.deleteByChatAndId(chatId, id);
  }

  async onQuote(quote: Quote): Promise<void> {
    const alerts = await this.repository.findActiveBySymbol(normalizeSymbol(quote.symbol));
    for (const alert of alerts) {
      if (!isAlertTriggered(alert.direction, quote.price, alert.targetPrice)) continue;
      if (!await this.repository.claim(alert.id, new Date().toISOString())) continue;
      this.logger.info('alert_triggered', { alertId: alert.id, symbol: alert.symbol, price: quote.price, targetPrice: alert.targetPrice });

      try {
        await this.notifier.sendAlert(alert, quote);
        await this.repository.markTriggered(alert.id, new Date().toISOString());
        this.logger.info('alert_notification_sent', { alertId: alert.id, symbol: alert.symbol });
      } catch (error) {
        await this.repository.releaseClaim(alert.id);
        this.logger.error('alert_delivery_failed', { alertId: alert.id, symbol: alert.symbol, error });
      }
    }
  }

  async recoverStaleClaims(): Promise<void> {
    const before = new Date(Date.now() - 5 * 60_000).toISOString();
    await this.repository.releaseStaleClaims(before);
    this.logger.info('stale_alert_claims_recovered', { before });
  }
}
