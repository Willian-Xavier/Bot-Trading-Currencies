import type { LogLevel } from '../application/ports.js';

export interface Config {
  telegramBotToken: string;
  mongodbUri: string;
  mongodbDatabase: string;
  mongodbDnsServers?: string[];
  tradingViewSession?: string;
  tradingViewSignature?: string;
  tradingViewDebug: boolean;
  logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const mongodbUri = env.MONGODB_URI?.trim();
  if (!mongodbUri) throw new Error('MONGODB_URI is required');
  const mongodbDnsServers = env.MONGODB_DNS_SERVERS?.split(',').map((server) => server.trim()).filter(Boolean);
  const configuredLogLevel = env.LOG_LEVEL?.trim().toLowerCase() || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(configuredLogLevel)) {
    throw new Error('LOG_LEVEL must be one of: debug, info, warn, error');
  }

  return {
    telegramBotToken: token,
    mongodbUri,
    mongodbDatabase: env.MONGODB_DATABASE?.trim() || 'telegram_market_alerts',
    mongodbDnsServers: mongodbDnsServers?.length ? mongodbDnsServers : undefined,
    tradingViewSession: env.TRADINGVIEW_SESSION?.trim() || undefined,
    tradingViewSignature: env.TRADINGVIEW_SIGNATURE?.trim() || undefined,
    tradingViewDebug: env.TRADINGVIEW_DEBUG === 'true',
    logLevel: configuredLogLevel as LogLevel,
  };
}
