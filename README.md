# Bot Telegram de alertas de mercado


<img src="Emblema Financeiro Azul com Seta Verde.png" alt="Texto alternativo" width="400" height="400">


Bot em Node.js + TypeScript para criar alertas de preço de ações e moedas estrangeiras no Telegram. As cotações são recebidas em tempo real através de `watchQuotes` da [TradingView-API](https://github.com/Mathieu2301/TradingView-API), versão 4.

> A TradingView-API é um projeto comunitário independente, não uma API oficial da TradingView. Este bot apenas consulta cotações e envia alertas; ele não executa ordens.

## O que está implementado

- Fluxo conversacional com botões para escolher **ação** ou **moeda**.
- Busca de símbolos com sugestões selecionáveis, como `BMFBOVESPA:PETR4`, `NASDAQ:AAPL` e `FX:EURUSD`.
- No fluxo de alertas, menu de bolsas, listagem real e paginada de ações, e seleção por botão, número ou nome da ação.
- Menu para listar ações por bolsa, consultar ações e converter uma moeda para outra.
- Alertas de compra (`preço atual <= preço-alvo`) e venda (`preço atual >= preço-alvo`).
- Disparo único por alerta, sem notificações repetidas após o preço cruzar o alvo.
- Persistência em MongoDB na nuvem, com recuperação de alertas em caso de reinício.
- Stream agrupado por símbolos ativos, reconexão automática e encerramento limpo.
- Logs estruturados no terminal com níveis, eventos e redaction de segredos.
- Porta `MarketDataSource` para substituir TradingView por outro fornecedor no futuro.
- Testes unitários para a regra de disparo e para a entrega idempotente.

## Requisitos

- Node.js 20 ou superior.
- Token de um bot criado via [@BotFather](https://t.me/BotFather).
- Acesso de rede para Telegram e TradingView.

## Configuração e execução

```bash
npm install
Copy-Item .env.example .env
```

Preencha `TELEGRAM_BOT_TOKEN` e `MONGODB_URI` no `.env`. Opcionalmente, altere `MONGODB_DATABASE`. A URI pode ser de MongoDB Atlas ou de outro deployment MongoDB acessível pelo processo.

### Logs

Os logs são exibidos em uma linha JSON por evento, com `timestamp`, `level`, `service` e `event`. Por padrão, são exibidos eventos `info`, `warn` e `error`. Para acompanhar atualizações individuais de cotação, use:

```env
LOG_LEVEL=debug
```

Níveis disponíveis: `debug`, `info`, `warn` e `error`. Tokens, senhas, cookies, assinaturas e URIs são redigidos automaticamente e não devem ser incluídos em mensagens de log.

Exemplo:

```text
{"timestamp":"2026-11-01T19:00:00.000Z","level":"info","service":"telegram-market-alerts","event":"alert_created","alertId":12,"symbol":"BMFBOVESPA:PETR4"}
```

Depois:

```bash
npm run dev
```

Para executar a versão compilada:

```bash
npm run check
npm start
```

O banco e as coleções são criados automaticamente pelo MongoDB na primeira inicialização. A aplicação cria índices para busca por chat, símbolo e estado do alerta.

### Erro `querySrv ECONNREFUSED`

Se o Node.js não conseguir resolver o registro SRV do MongoDB Atlas, configure no `.env`:

```env
MONGODB_DNS_SERVERS=1.1.1.1,8.8.8.8
```

Essa opção altera apenas os servidores DNS usados pelo processo. Se a rede corporativa bloquear DNS externo, gere no MongoDB Atlas uma URI de conexão padrão `mongodb://...` e use-a em `MONGODB_URI`, ou libere a resolução SRV na rede.

## Comandos do bot

- `/start` ou `/help`: mostra a ajuda.
- `/newalert`: inicia o fluxo para criar um alerta.
- `/alerts`: lista alertas ativos e já disparados.
- No menu inicial, `📋 Meus alertas` exibe os alertas do chat atual.
- `/stocks BOLSA`: lista ações de uma bolsa com paginação, por exemplo `/stocks BMFBOVESPA`. Pelo menu principal, a bolsa também pode ser escolhida por botões.
- `/stockquote`: consulta a cotação atual de uma ação.
- `/currencyquote`: escolhe duas moedas e exibe a conversão, por exemplo `1 USD = 5,43 BRL`.
- `/delete ID`: remove um alerta pelo ID.
- `/cancel`: cancela o fluxo atual.

Um alerta disparado é mantido no histórico com o estado `disparado`. Para criar outro alerta para o mesmo ativo, use `/newalert` novamente.

## TradingView e limitações de dados

O bot usa acesso anônimo por padrão. A própria biblioteca informa que o acesso anônimo pode ter dados atrasados, feeds substitutos e limites de histórico. Caso sua conta tenha acesso aos dados necessários, configure localmente `TRADINGVIEW_SESSION` e `TRADINGVIEW_SIGNATURE`; nunca coloque esses cookies no código, no Git ou em logs.

Os símbolos precisam ser qualificados pela bolsa/feed. Durante `/newalert`, escolha a bolsa no menu e selecione a ação pelo botão, pelo número da página ou pelo nome/ticker da ação. O bot mantém internamente o símbolo completo; por exemplo, a ação `PETR4` da bolsa B3 é resolvida como `BMFBOVESPA:PETR4`.

Na criação de alertas, os botões são `Listar ações` e `Listar moedas`. Para ações, o bot oferece bolsas populares, uma opção para informar outra bolsa e uma lista paginada com seleção por botão, número ou nome. Para moedas, o fluxo é igual à conversão: primeiro selecione a moeda de origem e depois a moeda de destino; o par completo é resolvido pela TradingView.

Para conversão de moedas, use `/currencyquote` e escolha a moeda base e depois a moeda de destino nos botões. O bot consulta o par direto quando disponível e inverte a taxa quando a TradingView só fornece o par contrário.

O Telegram não envia eventos de cada tecla digitada para bots em conversas comuns. Por isso, o autocomplete é atualizado a cada mensagem enviada e a escolha final é feita por botão. Um autocomplete dentro do campo de texto exigiria um Telegram Web App ou o modo inline habilitado no BotFather.

## Arquitetura

```text
TelegramBotApp ──┐
                 ├── AlertService ── AlertRepository (MongoDB)
WatcherManager ──┘        │
                          ├── AlertNotifier (Telegram)
                          └── MarketDataSource (TradingView)
```

As regras de negócio não importam `grammy`, MongoDB ou TradingView. As interfaces em `src/application/ports.ts` são os pontos de substituição. Para trocar a fonte:

1. Implemente `MarketDataSource` com `getQuote`, `searchSymbols` e `watchQuotes`.
2. Converta o formato externo para `Quote`.
3. Troque a instanciação de `TradingViewMarketDataSource` em `src/main.ts`.
4. Mantenha `AlertService`, `WatcherManager`, o banco e o bot inalterados.

## Plano de implementação e validação

O plano detalhado está em [`docs/implementation-plan.md`](docs/implementation-plan.md). Em resumo:

1. Validar contrato com usuários: formato dos símbolos, semântica de compra/venda, alertas únicos e retenção do histórico.
2. Validar localmente regra, persistência e idempotência com `npm run check`.
3. Validar integração de dados com um alerta de teste usando um símbolo líquido e conta TradingView adequada.
4. Validar Telegram em um chat privado: criação, listagem, exclusão, disparo, reinício do processo e reconexão.
5. Antes de produção, adicionar observabilidade, segredo gerenciado, política de backup/retention do MongoDB e um health check externo.

## Segurança e operação

- Não registre token do Telegram nem cookies TradingView.
- Restrinja o bot a chats autorizados antes de disponibilizá-lo publicamente, caso essa seja uma exigência do projeto.
- Use processo supervisionado (Docker, systemd, PM2 ou serviço equivalente) para reiniciar o bot após falhas.
- Configure backup e retenção no MongoDB Atlas ou na plataforma MongoDB utilizada.
- Este projeto não é recomendação de investimento e não garante execução de ordens ou latência de mercado.
