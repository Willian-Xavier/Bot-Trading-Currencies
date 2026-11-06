import 'dotenv/config';
import dns from 'node:dns/promises';
import { Bot } from 'grammy';
import { AlertService } from './application/alert-service.js';
import { WatcherManager } from './application/watcher-manager.js';
import { loadConfig } from './infrastructure/config.js';
import { MongoAlertRepository } from './infrastructure/mongo-alert-repository.js';
import { TelegramBotApp } from './infrastructure/telegram-bot.js';
import { TelegramNotifier } from './infrastructure/telegram-notifier.js';
import { TradingViewMarketDataSource } from './infrastructure/tradingview-market-data-source.js';
import { createLogger } from './infrastructure/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info('application_starting', { database: config.mongodbDatabase, logLevel: config.logLevel });
  if (config.mongodbDnsServers) {
    dns.setServers(config.mongodbDnsServers);
    logger.info('mongodb_dns_servers_configured', { serverCount: config.mongodbDnsServers.length });
  }
  const repository = new MongoAlertRepository(config.mongodbUri, config.mongodbDatabase, logger);
  await repository.connect();
  const source = new TradingViewMarketDataSource({
    session: config.tradingViewSession,
    signature: config.tradingViewSignature,
    debug: config.tradingViewDebug,
  }, logger);

  const telegram = new Bot(config.telegramBotToken);
  const alertService = new AlertService(repository, source, new TelegramNotifier(telegram, logger), logger);
  const watcherManager = new WatcherManager(repository, source, alertService, logger);
  const botApp = new TelegramBotApp(telegram, alertService, watcherManager, source, logger);

  await alertService.recoverStaleClaims();
  await watcherManager.start();
  await botApp.start();
  logger.info('bot_started', { database: config.mongodbDatabase });

  const shutdown = async (signal: string) => {
    logger.info('bot_stopping', { signal });
    await watcherManager.stop();
    await botApp.stop();
    await repository.close();
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  createLogger().error('bot_start_failed', { error });
  process.exitCode = 1;
});
