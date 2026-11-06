import type { Bot } from 'grammy';
import type { AlertNotifier, Logger, Quote } from '../application/ports.js';
import type { Alert } from '../domain/alert.js';

export class TelegramNotifier implements AlertNotifier {
  constructor(private readonly bot: Bot, private readonly logger: Logger) {}

  async sendAlert(alert: Alert, quote: Quote): Promise<void> {
    const action = alert.direction === 'buy' ? 'compra' : 'venda';
    const time = quote.timestamp ? new Date(quote.timestamp * 1000).toLocaleString('pt-BR') : 'agora';
    await this.bot.api.sendMessage(alert.chatId, [
      '🚨 <b>Alerta atingido</b>',
      `Ativo: <code>${escapeHtml(alert.symbol)}</code>`,
      `Tipo: ${alert.assetType === 'stock' ? 'ação' : 'moeda'}`,
      `Condição: ${action} em ${formatPrice(alert.targetPrice)}`,
      `Preço atual: <b>${formatPrice(quote.price)}</b>`,
      `Atualizado: ${escapeHtml(time)}`,
      `ID do alerta: <code>${alert.id}</code>`,
    ].join('\n'), { parse_mode: 'HTML' });
    this.logger.info('telegram_alert_sent', { alertId: alert.id, symbol: alert.symbol });
  }
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 }).format(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
