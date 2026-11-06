import type { LogLevel, Logger } from '../application/ports.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /(token|password|secret|signature|session|cookie|authorization|uri)/i;

export class ConsoleLogger implements Logger {
  constructor(
    private readonly minLevel: LogLevel = 'info',
    private readonly service = 'telegram-market-alerts',
  ) {}

  debug(event: string, context?: Record<string, unknown>): void {
    this.write('debug', event, context);
  }

  info(event: string, context?: Record<string, unknown>): void {
    this.write('info', event, context);
  }

  warn(event: string, context?: Record<string, unknown>): void {
    this.write('warn', event, context);
  }

  error(event: string, context?: Record<string, unknown>): void {
    this.write('error', event, context);
  }

  private write(level: LogLevel, event: string, context: Record<string, unknown> = {}): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      event,
      ...sanitizeRecord(context),
    };
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export function createLogger(level: LogLevel = 'info'): Logger {
  return new ConsoleLogger(level);
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeValue(key, value)]));
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) return {
    name: value.name,
    message: redactText(value.message),
    stack: value.stack ? redactText(value.stack) : undefined,
  };
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue('', item));
  if (value && typeof value === 'object') return sanitizeRecord(value as Record<string, unknown>);
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/(mongodb(?:\+srv)?[^\s"']*:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(bot_token|api[_-]?key|sessionid[_-]?sign?)[=:][^\s,;]+/gi, '$1=[REDACTED]');
}
