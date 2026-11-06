import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { AlertService } from '../application/alert-service.js';
import type { Logger, MarketDataSource, StockListPage, SymbolSuggestion } from '../application/ports.js';
import type { WatcherManager } from '../application/watcher-manager.js';
import { directionLabel, isValidTradingViewSymbol, type Alert, type AlertDirection, type AssetType } from '../domain/alert.js';

type Flow =
  | { stage: 'assetType' }
  | { stage: 'symbol'; assetType: AssetType; purpose: 'alert' | 'quote' }
  | { stage: 'target'; assetType: AssetType; symbol: string }
  | { stage: 'direction'; assetType: AssetType; symbol: string; targetPrice: number }
  | { stage: 'stockExchange'; purpose: 'browse' | 'alert' | 'quote' }
  | { stage: 'stockList'; exchange: string; offset: number; purpose: 'browse' | 'alert' | 'quote' }
  | { stage: 'currencyBase'; purpose: 'quote' | 'alert' }
  | { stage: 'currencyQuote'; baseCurrency: string; purpose: 'quote' | 'alert' };

export class TelegramBotApp {
  readonly bot: Bot;
  private readonly flows = new Map<string, Flow>();

  constructor(
    bot: Bot,
    private readonly alerts: AlertService,
    private readonly watcherManager: WatcherManager,
    private readonly marketData: MarketDataSource,
    private readonly logger: Logger,
  ) {
    this.bot = bot;
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Iniciar o bot' },
      { command: 'newalert', description: 'Criar um alerta' },
      { command: 'alerts', description: 'Listar meus alertas' },
      { command: 'stocks', description: 'Listar ações de uma bolsa' },
      { command: 'stockquote', description: 'Consultar cotação de ação' },
      { command: 'currencyquote', description: 'Consultar cotação de moeda' },
      { command: 'delete', description: 'Excluir alerta por ID' },
      { command: 'cancel', description: 'Cancelar o fluxo atual' },
      { command: 'help', description: 'Mostrar ajuda' },
    ]);
    this.logger.info('telegram_commands_registered');
    // grammY keeps this promise pending for the lifetime of long polling. Do not
    // await it here, otherwise the application cannot install shutdown handlers.
    void this.bot.start({ allowed_updates: ['message', 'callback_query'] }).catch((error) => {
      this.logger.error('telegram_polling_failed', { error });
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private registerHandlers(): void {
    this.bot.command(['start', 'help'], async (ctx) => {
      this.logger.info('telegram_help_requested');
      await ctx.reply(helpText(), { parse_mode: 'HTML', reply_markup: mainKeyboard() });
    });

    this.bot.command('newalert', async (ctx) => {
      this.logger.info('telegram_command_received', { command: 'newalert' });
      await this.begin(ctx);
    });

    this.bot.command('stocks', async (ctx) => {
      this.logger.info('telegram_command_received', { command: 'stocks' });
      await this.beginStockList(ctx, ctx.match.trim());
    });

    this.bot.command('stockquote', async (ctx) => {
      this.logger.info('telegram_command_received', { command: 'stockquote' });
      const query = ctx.match.trim();
      if (query) await this.beginQuote(ctx, 'stock', query);
      else await this.beginStockList(ctx, '', 'quote');
    });

    this.bot.command('currencyquote', async (ctx) => {
      this.logger.info('telegram_command_received', { command: 'currencyquote' });
      await this.beginCurrencyQuote(ctx);
    });

    this.bot.command('cancel', async (ctx) => {
      this.logger.info('telegram_command_received', { command: 'cancel' });
      this.flows.delete(chatId(ctx));
      await ctx.reply('🛑 Fluxo cancelado.');
    });

    this.bot.command('alerts', async (ctx) => {
      this.logger.info('telegram_command_received', { command: 'alerts' });
      await ctx.reply(formatAlerts(await this.alerts.list(chatId(ctx))), { parse_mode: 'HTML' });
    });

    this.bot.command('delete', async (ctx) => {
      this.logger.info('telegram_command_received', { command: 'delete' });
      const value = ctx.match.trim();
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) {
        await ctx.reply('⚠️ Uso: /delete ID. Exemplo: /delete 12');
        return;
      }
      const deleted = await this.alerts.delete(chatId(ctx), id);
      if (deleted) await this.watcherManager.refresh();
      await ctx.reply(deleted ? `✅ Alerta #${id} excluído.` : '⚠️ Não encontrei esse alerta entre os seus alertas.');
    });

    this.bot.callbackQuery(/^alert:(stock|forex)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      this.logger.info('telegram_alert_asset_selected', { assetType: ctx.callbackQuery.data.split(':')[1] });
      const assetType = ctx.callbackQuery.data.split(':')[1] as AssetType;
      this.flows.set(chatId(ctx), { stage: 'symbol', assetType, purpose: 'alert' });
      await ctx.editMessageReplyMarkup();
      await ctx.reply(assetType === 'stock'
        ? 'Digite parte do ticker da ação ou escolha uma bolsa no menu. Depois, selecione a ação pelo botão, número ou nome.'
        : 'Digite parte do par de moedas ou escolha as moedas nos botões para montar a conversão.',
        { reply_markup: alertBrowseKeyboard(assetType) });
    });

    this.bot.callbackQuery(/^alert-list:(stock|forex)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const assetType = ctx.callbackQuery.data.split(':')[1] as AssetType;
      this.logger.info('telegram_alert_market_list_requested', { assetType });
      await ctx.editMessageReplyMarkup();
      if (assetType === 'stock') await this.beginStockList(ctx, '', 'alert');
      else await this.beginCurrencyQuote(ctx, 'alert');
    });

    this.bot.callbackQuery(/^exchange:(alert|browse|quote):([A-Z0-9_-]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, purpose, exchange] = ctx.callbackQuery.data.split(':');
      if (!purpose || !exchange) {
        await ctx.reply('⚠️ Essa opção expirou. Use /stocks ou /stockquote para começar novamente.');
        return;
      }
      this.logger.info('telegram_exchange_selected', { purpose, exchange });
      await ctx.editMessageReplyMarkup();
      await this.beginStockList(ctx, exchange, purpose as 'browse' | 'alert' | 'quote');
    });

    this.bot.callbackQuery(/^exchange-other:(alert|browse|quote)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const purpose = ctx.callbackQuery.data.split(':')[1] as 'browse' | 'alert' | 'quote';
      this.flows.set(chatId(ctx), { stage: 'stockExchange', purpose });
      await ctx.editMessageReplyMarkup();
      await ctx.reply('⌨️ Informe o código da bolsa, por exemplo TSX ou HKEX.');
    });

    this.bot.callbackQuery(/^menu:(newalert|alerts|stocks|quote:(stock|forex))$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      this.logger.debug('telegram_menu_action_selected', { action: ctx.callbackQuery.data });
      const action = ctx.callbackQuery.data.slice('menu:'.length);
      await ctx.editMessageReplyMarkup();
      if (action === 'newalert') await this.begin(ctx);
      else if (action === 'alerts') await ctx.reply(formatAlerts(await this.alerts.list(chatId(ctx))), { parse_mode: 'HTML' });
      else if (action === 'stocks') await this.beginStockList(ctx, '');
      else if (action === 'quote:forex') await this.beginCurrencyQuote(ctx);
      else await this.beginStockList(ctx, '', 'quote');
    });

    this.bot.callbackQuery(/^currency:(base|quote):([A-Z]{3})$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      this.logger.info('telegram_currency_selected', { selection: ctx.callbackQuery.data.split(':')[1], currency: ctx.callbackQuery.data.split(':')[2] });
      const [, selection, currency] = ctx.callbackQuery.data.split(':');
      if (!selection || !currency) {
        await ctx.reply('⚠️ Essa opção expirou. Use /currencyquote para começar novamente.');
        return;
      }
      if (selection === 'base') {
        const currentFlow = this.flows.get(chatId(ctx));
        if (!currentFlow || currentFlow.stage !== 'currencyBase') {
          await ctx.reply('⚠️ Essa consulta expirou. Use /currencyquote para começar novamente.');
          return;
        }
        this.flows.set(chatId(ctx), { stage: 'currencyQuote', baseCurrency: currency, purpose: currentFlow.purpose });
        await ctx.editMessageReplyMarkup();
        await ctx.reply(`✅ Moeda escolhida: ${currency}\n💱 Agora escolha a segunda moeda para conversão.`, {
          reply_markup: currencyKeyboard('quote', currency),
        });
        return;
      }
      const flow = this.flows.get(chatId(ctx));
      if (!flow || flow.stage !== 'currencyQuote') {
        await ctx.reply('⚠️ Essa consulta expirou. Use /currencyquote para começar novamente.');
        return;
      }
      if (flow.baseCurrency === currency) {
        await ctx.reply('⚠️ Escolha uma moeda diferente da primeira.');
        return;
      }
      await ctx.editMessageReplyMarkup();
      if (flow.purpose === 'quote') {
        this.flows.delete(chatId(ctx));
        await this.sendCurrencyQuote(ctx, flow.baseCurrency, currency);
      } else {
        await this.prepareCurrencyAlert(ctx, flow.baseCurrency, currency);
      }
    });

    this.bot.callbackQuery(/^stocks:(prev|next):([A-Z0-9_-]+):(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      this.logger.debug('telegram_stock_page_requested', { page: ctx.callbackQuery.data });
      const [, direction, exchange, offsetText] = ctx.callbackQuery.data.split(':');
      const offset = Number(offsetText);
      const nextOffset = direction === 'next' ? offset + 20 : Math.max(0, offset - 20);
      if (!exchange || !Number.isFinite(offset)) {
        await ctx.reply('⚠️ Essa página de ações expirou. Use /stocks para começar novamente.');
        return;
      }
      await this.sendStockPage(ctx, exchange, nextOffset, 'browse');
    });

    this.bot.callbackQuery(/^alertstocks:(prev|next):([A-Z0-9_-]+):(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, direction, exchange, offsetText] = ctx.callbackQuery.data.split(':');
      const offset = Number(offsetText);
      const nextOffset = direction === 'next' ? offset + 20 : Math.max(0, offset - 20);
      if (!exchange || !Number.isFinite(offset)) {
        await ctx.reply('⚠️ Essa página de ações expirou. Use /newalert para começar novamente.');
        return;
      }
      await this.sendStockPage(ctx, exchange, nextOffset, 'alert');
    });

    this.bot.callbackQuery(/^stockquote:(prev|next):([A-Z0-9_-]+):(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, direction, exchange, offsetText] = ctx.callbackQuery.data.split(':');
      const offset = Number(offsetText);
      const nextOffset = direction === 'next' ? offset + 20 : Math.max(0, offset - 20);
      if (!exchange || !Number.isFinite(offset)) {
        await ctx.reply('⚠️ Essa página expirou. Use /stockquote para começar novamente.');
        return;
      }
      await this.sendStockPage(ctx, exchange, nextOffset, 'quote');
    });

    this.bot.callbackQuery(/^symbols:(stock|forex)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      this.logger.debug('telegram_symbol_suggestions_requested', { assetType: ctx.callbackQuery.data.split(':')[1] });
      const assetType = ctx.callbackQuery.data.split(':')[1] as AssetType;
      await this.sendSymbolSuggestions(ctx, assetType, '');
    });

    this.bot.callbackQuery(/^symbol:.+$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      this.logger.info('telegram_symbol_selected', { symbol: ctx.callbackQuery.data.slice('symbol:'.length) });
      const flow = this.flows.get(chatId(ctx));
      const selectableList = flow?.stage === 'stockList' && flow.purpose !== 'browse';
      if (!flow || (flow.stage !== 'symbol' && !selectableList)) {
        await ctx.reply('⚠️ Essa busca expirou. Use /newalert para começar novamente.');
        return;
      }
      const symbol = ctx.callbackQuery.data.slice('symbol:'.length).toUpperCase();
      if (!isValidTradingViewSymbol(symbol)) {
        await ctx.reply('⚠️ Não consegui reconhecer esse símbolo. Use /newalert para tentar novamente.');
        return;
      }
      await ctx.editMessageReplyMarkup();
      const purpose = flow.stage === 'symbol' ? flow.purpose : flow.purpose;
      const assetType = flow.stage === 'symbol' ? flow.assetType : 'stock';
      if (purpose === 'quote') {
        this.flows.delete(chatId(ctx));
        await this.sendQuote(ctx, symbol, assetType);
      } else {
        this.flows.set(chatId(ctx), { stage: 'target', assetType, symbol });
        await ctx.reply(`✅ Símbolo selecionado: ${symbol}\n🎯 Qual é o preço-alvo? Use apenas um número positivo, por exemplo 180.50.`);
      }
    });

    this.bot.callbackQuery(/^direction:(buy|sell)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      this.logger.info('telegram_alert_direction_selected', { direction: ctx.callbackQuery.data.split(':')[1] });
      const flow = this.flows.get(chatId(ctx));
      if (!flow || flow.stage !== 'direction') {
        await ctx.reply('⚠️ Esse fluxo expirou. Use /newalert para começar novamente.');
        return;
      }
      const direction = ctx.callbackQuery.data.split(':')[1] as AlertDirection;
      try {
        const alert = await this.alerts.create({ ...flow, direction, chatId: chatId(ctx) });
        this.flows.delete(chatId(ctx));
        await this.watcherManager.refresh();
        await ctx.editMessageReplyMarkup();
        await ctx.reply(`✅ Alerta #${alert.id} criado para ${alert.symbol}.\n📌 Condição: ${directionLabel(direction)} ${formatPrice(alert.targetPrice)}.`);
      } catch (error) {
        this.logger.error('alert_creation_failed', { error });
        await ctx.reply('⚠️ Não consegui validar esse símbolo agora. Confira o formato e tente novamente em alguns instantes.');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;
      await this.handleText(ctx, ctx.message.text.trim());
    });

    this.bot.catch((error) => {
      this.logger.error('telegram_error', { error: error.error });
    });
  }

  private async handleText(ctx: Context, text: string): Promise<void> {
    const key = chatId(ctx);
    const flow = this.flows.get(key);
    if (!flow) {
      await ctx.reply('ℹ️ Use /newalert para criar um alerta ou /help para ver os comandos.');
      return;
    }
    if (flow.stage === 'assetType') {
      await ctx.reply('👆 Escolha uma opção nos botões abaixo.', { reply_markup: alertAssetKeyboard() });
      return;
    }
    if (flow.stage === 'symbol') {
      if (text.length < 1) {
        await ctx.reply('⌨️ Digite pelo menos uma letra ou número do símbolo.');
        return;
      }
      await this.sendSymbolSuggestions(ctx, flow.assetType, text);
      return;
    }
    if (flow.stage === 'stockExchange') {
      await this.beginStockList(ctx, text, flow.purpose);
      return;
    }
    if (flow.stage === 'stockList') {
      if (flow.purpose === 'alert' || flow.purpose === 'quote') await this.selectStockFromText(ctx, flow, text);
      else await this.sendStockPage(ctx, flow.exchange, 0, flow.purpose);
      return;
    }
    if (flow.stage === 'currencyBase') {
      const currency = parseCurrency(text);
      if (!currency) {
        await ctx.reply('⚠️ Informe um código de moeda com 3 letras, como USD, BRL ou EUR.');
        return;
      }
      this.flows.set(key, { stage: 'currencyQuote', baseCurrency: currency, purpose: flow.purpose });
      await ctx.reply(`✅ Moeda escolhida: ${currency}\n💱 Agora escolha a segunda moeda para conversão.`, {
        reply_markup: currencyKeyboard('quote', currency),
      });
      return;
    }
    if (flow.stage === 'currencyQuote') {
      const currency = parseCurrency(text);
      if (!currency) {
        await ctx.reply('⚠️ Informe um código de moeda com 3 letras, como USD, BRL ou EUR.');
        return;
      }
      if (currency === flow.baseCurrency) {
        await ctx.reply('⚠️ Escolha uma moeda diferente da primeira.');
        return;
      }
      if (flow.purpose === 'quote') {
        this.flows.delete(key);
        await this.sendCurrencyQuote(ctx, flow.baseCurrency, currency);
      } else {
        await this.prepareCurrencyAlert(ctx, flow.baseCurrency, currency);
      }
      return;
    }
    if (flow.stage === 'target') {
      const targetPrice = Number(text.replace(',', '.'));
      if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
        await ctx.reply('⚠️ Preço inválido. Informe um número positivo.');
        return;
      }
      this.flows.set(key, { ...flow, stage: 'direction', targetPrice });
      await ctx.reply('🎯 Você quer ser avisado para:', { reply_markup: directionKeyboard() });
    }
  }

  private async sendSymbolSuggestions(ctx: Context, assetType: AssetType, query: string): Promise<void> {
    try {
      const suggestions = await this.marketData.searchSymbols(query, assetType);
      if (suggestions.length === 0) {
        await ctx.reply('🔎 Nenhum símbolo encontrado. Tente outro ticker ou use /cancel.');
        return;
      }
      await ctx.reply(query ? `🔎 Resultados para "${query.toUpperCase()}":` : '📋 Sugestões populares:', {
        reply_markup: symbolKeyboard(suggestions),
      });
    } catch (error) {
      this.logger.error('symbol_search_failed', { error });
      await ctx.reply('⚠️ Não consegui consultar os símbolos agora. Tente novamente em alguns instantes.');
    }
  }

  private async beginQuote(ctx: Context, assetType: AssetType, query: string): Promise<void> {
    this.flows.set(chatId(ctx), { stage: 'symbol', assetType, purpose: 'quote' });
    await ctx.reply(assetType === 'stock'
      ? '📈 Digite parte do ticker da ação para consultar a cotação atual.'
      : '💱 Digite parte do par de moedas para consultar a cotação atual.',
      { reply_markup: symbolBrowseKeyboard(assetType) });
    if (query) await this.sendSymbolSuggestions(ctx, assetType, query);
  }

  private async beginCurrencyQuote(ctx: Context, purpose: 'quote' | 'alert' = 'quote'): Promise<void> {
    this.flows.set(chatId(ctx), { stage: 'currencyBase', purpose });
    await ctx.reply(purpose === 'alert' ? '💱 Escolha a primeira moeda do alerta:' : '💱 Escolha a primeira moeda da conversão:', {
      reply_markup: currencyKeyboard('base'),
    });
  }

  private async beginStockList(ctx: Context, exchange: string, purpose: 'browse' | 'alert' | 'quote' = 'browse'): Promise<void> {
    if (!exchange) {
      this.flows.set(chatId(ctx), { stage: 'stockExchange', purpose });
      await ctx.reply('🏛️ Escolha a bolsa:', { reply_markup: exchangeKeyboard(purpose) });
      return;
    }
    const normalizedExchange = exchange.replace(/:$/, '').toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(normalizedExchange)) {
      await ctx.reply('⚠️ Código de bolsa inválido. Use apenas letras, números, hífen ou sublinhado.');
      return;
    }
    await this.sendStockPage(ctx, normalizedExchange, 0, purpose);
  }

  private async sendStockPage(ctx: Context, exchange: string, offset: number, purpose: 'browse' | 'alert' | 'quote'): Promise<void> {
    try {
      const page = await this.marketData.listStocks(exchange, offset);
      if (page.symbols.length === 0) {
        await ctx.reply(`🔎 Não encontrei ações para a bolsa ${exchange}. Verifique o código e tente novamente.`);
        return;
      }
      this.flows.set(chatId(ctx), { stage: 'stockList', exchange, offset, purpose });
      await ctx.reply(purpose === 'browse'
        ? formatStockPage(page)
        : purpose === 'quote'
          ? '📊 Selecione uma ação para consultar a cotação pelo botão, número ou nome exibido:'
          : '📈 Selecione uma ação pelo botão, número ou nome exibido:', {
        parse_mode: 'HTML',
        reply_markup: purpose === 'browse'
          ? stockPageKeyboard(page)
          : selectionStockPageKeyboard(page, purpose === 'quote' ? 'stockquote' : 'alertstocks'),
      });
    } catch (error) {
      this.logger.error('stock_list_failed', { error, exchange, offset });
      await ctx.reply('⚠️ Não consegui listar as ações agora. Tente novamente em alguns instantes.');
    }
  }

  private async prepareCurrencyAlert(ctx: Context, baseCurrency: string, quoteCurrency: string): Promise<void> {
    try {
      const conversion = await this.marketData.getCurrencyQuote(baseCurrency, quoteCurrency);
      if (conversion.inverted) {
        await ctx.reply(`⚠️ O par direto ${baseCurrency}/${quoteCurrency} não está disponível. Escolha as moedas na ordem inversa.`);
        return;
      }
      this.flows.set(chatId(ctx), { stage: 'target', assetType: 'forex', symbol: conversion.symbol });
      await ctx.reply(`✅ Par selecionado: ${baseCurrency}/${quoteCurrency}\n🎯 Informe o preço-alvo da conversão (ex.: 5.40).`);
    } catch (error) {
      this.logger.error('currency_alert_pair_failed', { error, baseCurrency, quoteCurrency });
      await ctx.reply(`⚠️ Não encontrei uma cotação direta para ${baseCurrency}/${quoteCurrency}. Escolha outro par.`);
    }
  }

  private async selectStockFromText(
    ctx: Context,
    flow: Extract<Flow, { stage: 'stockList' }>,
    text: string,
  ): Promise<void> {
    try {
      const page = await this.marketData.listStocks(flow.exchange, flow.offset);
      const value = text.trim();
      const numeric = Number(value);
      let index = Number.isInteger(numeric) ? numeric - 1 : -1;
      if (numeric >= flow.offset + 1 && numeric <= flow.offset + page.symbols.length) index = numeric - flow.offset - 1;
      const normalized = value.toLocaleLowerCase('pt-BR');
      const selected = (index >= 0 && index < page.symbols.length ? page.symbols[index] : undefined)
        ?? page.symbols.find((symbol) => symbol.id.split(':')[1]?.toLocaleLowerCase('pt-BR') === normalized)
        ?? page.symbols.find((symbol) => symbol.description.toLocaleLowerCase('pt-BR').includes(normalized));
      if (!selected) {
        await ctx.reply('⚠️ Não encontrei essa ação nesta página. Escolha um botão, número ou nome exibido.');
        return;
      }
      if (flow.purpose === 'quote') {
        this.flows.delete(chatId(ctx));
        await this.sendQuote(ctx, selected.id, 'stock');
      } else {
        this.flows.set(chatId(ctx), { stage: 'target', assetType: 'stock', symbol: selected.id });
        await ctx.reply(`✅ Ação selecionada: ${selected.description} (${tickerFromSymbol(selected.id)})\n🎯 Informe o preço-alvo (ex.: 50.00).`);
      }
    } catch (error) {
      this.logger.error('alert_stock_selection_failed', { error, exchange: flow.exchange, offset: flow.offset });
      await ctx.reply('⚠️ Não consegui localizar essa ação agora. Tente novamente.');
    }
  }

  private async sendQuote(ctx: Context, symbol: string, assetType: AssetType): Promise<void> {
    try {
      const quote = await this.marketData.getQuote(symbol);
      const label = assetType === 'stock' ? 'ação' : 'moeda';
      const lines = [
        `📊 <b>Cotação atual da ${label}</b>`,
        `Símbolo: <code>${escapeHtml(symbol)}</code>`,
        quote.description ? `Ativo: ${escapeHtml(quote.description)}` : '',
        `Preço: <b>${formatPrice(quote.price)}</b>${quote.currency ? ` ${escapeHtml(quote.currency)}` : ''}`,
        quote.timestamp ? `Atualizado: ${escapeHtml(new Date(quote.timestamp * 1000).toLocaleString('pt-BR'))}` : '',
      ].filter(Boolean);
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error('quote_lookup_failed', { error, symbol });
      await ctx.reply('⚠️ Não consegui obter a cotação desse símbolo agora. Tente selecionar outro resultado.');
    }
  }

  private async sendCurrencyQuote(ctx: Context, baseCurrency: string, quoteCurrency: string): Promise<void> {
    try {
      const conversion = await this.marketData.getCurrencyQuote(baseCurrency, quoteCurrency);
      const lines = [
        '💱 <b>Cotação da conversão</b>',
        `<code>1 ${conversion.baseCurrency} = ${formatPrice(conversion.rate)} ${conversion.quoteCurrency}</code>`,
        `Par consultado: <code>${escapeHtml(conversion.symbol)}</code>`,
        conversion.description ? escapeHtml(conversion.description) : '',
        conversion.timestamp ? `Atualizado: ${escapeHtml(new Date(conversion.timestamp * 1000).toLocaleString('pt-BR'))}` : '',
      ].filter(Boolean);
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error('currency_quote_failed', { error, baseCurrency, quoteCurrency });
      await ctx.reply(`⚠️ Não encontrei uma cotação disponível para ${baseCurrency}/${quoteCurrency}. Escolha outro par e tente novamente.`);
    }
  }

  private async begin(ctx: Context): Promise<void> {
    this.flows.set(chatId(ctx), { stage: 'assetType' });
    await ctx.reply('🚨 Você quer criar um alerta para uma ação ou moeda?', { reply_markup: alertAssetKeyboard() });
  }
}

function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🆕 Criar alerta', 'menu:newalert').row()
    .text('📋 Meus alertas', 'menu:alerts').row()
    .text('📋 Listar ações por bolsa', 'menu:stocks').row()
    .text('📈 Cotação de ação', 'menu:quote:stock')
    .text('💱 Cotação de moeda', 'menu:quote:forex');
}

function alertAssetKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('📈 Ação', 'alert:stock').text('💱 Moeda', 'alert:forex');
}

function directionKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🟢 Compra (≤ alvo)', 'direction:buy').text('🔴 Venda (≥ alvo)', 'direction:sell');
}

function symbolBrowseKeyboard(assetType: AssetType): InlineKeyboard {
  return new InlineKeyboard().text('📋 Listar sugestões', `symbols:${assetType}`);
}

function alertBrowseKeyboard(assetType: AssetType): InlineKeyboard {
  return new InlineKeyboard().text(
    assetType === 'stock' ? '📋 Listar ações' : '💱 Listar moedas',
    `alert-list:${assetType}`,
  );
}

function symbolKeyboard(suggestions: SymbolSuggestion[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const suggestion of suggestions) {
    const description = suggestion.description ? ` — ${suggestion.description.slice(0, 35)}` : '';
    keyboard.text(`${suggestion.id}${description}`, `symbol:${suggestion.id}`).row();
  }
  return keyboard;
}

function currencyKeyboard(selection: 'base' | 'quote', excluded?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const available = CURRENCIES.filter((currency) => currency.code !== excluded);
  for (let index = 0; index < available.length; index += 2) {
    const first = available[index];
    const second = available[index + 1];
    if (first) keyboard.text(`${first.code} — ${first.name}`, `currency:${selection}:${first.code}`);
    if (second) keyboard.text(`${second.code} — ${second.name}`, `currency:${selection}:${second.code}`);
    keyboard.row();
  }
  return keyboard;
}

function stockPageKeyboard(page: StockListPage): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (page.offset > 0) keyboard.text('⬅️ Anterior', `stocks:prev:${page.exchange}:${page.offset}`);
  if (page.hasMore) keyboard.text('Próxima ➡️', `stocks:next:${page.exchange}:${page.offset}`);
  return keyboard;
}

function selectionStockPageKeyboard(page: StockListPage, prefix: 'alertstocks' | 'stockquote'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  page.symbols.forEach((symbol, index) => {
    const ticker = tickerFromSymbol(symbol.id);
    const description = symbol.description ? ` — ${symbol.description.slice(0, 42)}` : '';
    keyboard.text(`${page.offset + index + 1}. ${ticker}${description}`, `symbol:${symbol.id}`).row();
  });
  addPagination(keyboard, page.offset, page.hasMore, prefix, page.exchange);
  return keyboard;
}

function exchangeKeyboard(purpose: 'browse' | 'alert' | 'quote'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const exchanges = [
    ['🇧🇷 B3', 'BMFBOVESPA'],
    ['🇺🇸 NASDAQ', 'NASDAQ'],
    ['🇺🇸 NYSE', 'NYSE'],
    ['🇺🇸 AMEX', 'AMEX'],
    ['🇬🇧 Londres', 'LSE'],
    ['🇭🇰 Hong Kong', 'HKEX'],
    ['🇯🇵 Tóquio', 'TSE'],
    ['🇨🇦 Toronto', 'TSX'],
  ] as const;

  for (let index = 0; index < exchanges.length; index += 2) {
    const first = exchanges[index];
    const second = exchanges[index + 1];
    if (first) keyboard.text(first[0], `exchange:${purpose}:${first[1]}`);
    if (second) keyboard.text(second[0], `exchange:${purpose}:${second[1]}`);
    keyboard.row();
  }
  keyboard.text('⌨️ Outra bolsa', `exchange-other:${purpose}`);
  return keyboard;
}

function addPagination(keyboard: InlineKeyboard, offset: number, hasMore: boolean, prefix: string, middle?: string): void {
  if (offset === 0 && !hasMore) return;
  keyboard.row();
  if (offset > 0) keyboard.text('⬅️ Anterior', middle ? `${prefix}:prev:${middle}:${offset}` : `${prefix}:prev:${offset}`);
  if (hasMore) keyboard.text('Próxima ➡️', middle ? `${prefix}:next:${middle}:${offset}` : `${prefix}:next:${offset}`);
}

function chatId(ctx: Context): string {
  return String(ctx.chat?.id ?? ctx.from?.id ?? '');
}

function formatAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return '📋 Você ainda não possui alertas. Use /newalert para criar um.';
  return ['📋 <b>Seus alertas</b>', ...alerts.map((alert) => {
    const state = alert.status === 'active' ? '🟢 ativo' : '✅ disparado';
    const action = alert.direction === 'buy' ? '🛒 compra ≤' : '💰 venda ≥';
    return `#${alert.id} · <code>${alert.symbol}</code> · ${action} ${formatPrice(alert.targetPrice)} · ${state}`;
  }), '', 'Para excluir: /delete ID'].join('\n');
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 }).format(value);
}

function helpText(): string {
  return [
    '📊 <b>Bot de alertas de mercado</b>',
    '',
    'Crio alertas de uma só execução para ações e moedas. A fonte de cotações é o TradingView.',
    '',
    '/newalert — 🚨 criar alerta',
    '/alerts — 📋 listar alertas',
    '/stocks BOLSA — 📈 listar ações de uma bolsa',
    '/stockquote — 💹 cotação atual de uma ação',
    '/currencyquote — 💱 converter uma moeda para outra',
    '/delete ID — 🗑️ excluir alerta',
    '/cancel — 🛑 cancelar o fluxo atual',
    '',
    'Símbolos devem estar no formato EXCHANGE:SYMBOL, como BMFBOVESPA:PETR4, NASDAQ:AAPL ou FX:EURUSD.',
  ].join('\n');
}

function formatStockPage(page: StockListPage): string {
  const pageNumber = Math.floor(page.offset / 20) + 1;
  const rows = page.symbols.map((symbol, index) => {
    const description = symbol.description ? ` — ${escapeHtml(symbol.description)}` : '';
    return `${page.offset + index + 1}. <code>${escapeHtml(symbol.id)}</code>${description}`;
  });
  return [`📈 <b>Ações da bolsa ${escapeHtml(page.exchange)}</b> · página ${pageNumber}`, '', ...rows].join('\n');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function tickerFromSymbol(symbol: string): string {
  return symbol.split(':')[1] ?? symbol;
}

function parseCurrency(value: string): string | undefined {
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

const CURRENCIES = [
  { code: 'BRL', name: 'Real' },
  { code: 'USD', name: 'Dólar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'Libra' },
  { code: 'JPY', name: 'Iene' },
  { code: 'CNY', name: 'Yuan' },
  { code: 'CHF', name: 'Franco suíço' },
  { code: 'CAD', name: 'Dólar canadense' },
  { code: 'AUD', name: 'Dólar australiano' },
];
