import type { AlertService } from './alert-service.js';
import type { AlertRepository, Logger, MarketDataSource, MarketDataWatcher } from './ports.js';

export class WatcherManager {
  private watcher: MarketDataWatcher | undefined;
  private running = false;
  private refreshing = false;
  private refreshQueued = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly repository: AlertRepository,
    private readonly source: MarketDataSource,
    private readonly alertService: AlertService,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.logger.info('market_watcher_starting');
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.running) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        await this.watcher?.stop();
        this.watcher = undefined;

        const symbols = await this.repository.listActiveSymbols();
        if (symbols.length === 0) {
          this.logger.debug('market_watcher_no_active_symbols');
          continue;
        }

        try {
          const watcher = await this.source.watchQuotes(symbols, {
            onQuote: (quote) => {
              void this.alertService.onQuote(quote).catch((error) => {
                this.logger.error('alert_processing_failed', { error });
              });
            },
            onError: (error) => this.logger.error('market_data_error', { error }),
          });
          this.watcher = watcher;
          this.logger.info('market_watcher_active', { symbolCount: symbols.length, symbols });
          void watcher.closed.then(() => {
            if (this.running && this.watcher === watcher) {
              this.watcher = undefined;
              this.scheduleReconnect();
            }
          });
        } catch (error) {
          this.logger.error('market_data_start_failed', { error, symbolCount: symbols.length });
          this.scheduleReconnect();
        }
      } while (this.refreshQueued && this.running);
    } finally {
      this.refreshing = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.watcher?.stop();
    this.watcher = undefined;
    this.logger.info('market_watcher_manager_stopped');
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.logger.warn('market_watcher_reconnect_scheduled', { delayMs: 10_000 });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.refresh();
    }, 10_000);
  }
}
