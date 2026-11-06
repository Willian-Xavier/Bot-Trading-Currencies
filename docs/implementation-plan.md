# Plano de implementação e validação

## Objetivo

Permitir que uma pessoa crie, liste e exclua alertas de preço no Telegram para ações e moedas, recebendo uma única notificação quando a cotação em tempo real atingir o limite configurado.

## Decisões de produto

| Decisão | Escolha inicial | Motivo |
| --- | --- | --- |
| Direção de compra | `preço <= alvo` | Uma ordem de compra normalmente busca um preço máximo aceitável. |
| Direção de venda | `preço >= alvo` | Uma ordem de venda normalmente busca um preço mínimo aceitável. |
| Repetição | Uma notificação por alerta | Evita spam quando a cotação permanece além do limite. |
| Fonte | TradingView-API v4 | Entrega `watchQuotes` e mantém o stream em tempo real. |
| Persistência | MongoDB na nuvem | Durável, acessível pelo URI e preparado para crescer além de uma instância. |
| Escalabilidade futura | Portas e adaptadores | Permite trocar fornecedor, Telegram ou banco sem reescrever as regras. |

## Fases

### Fase 1 — Contrato e regras

- Confirmar com usuários se compra/venda devem seguir a semântica acima.
- Confirmar se alertas devem ser únicos ou recorrentes.
- Confirmar os feeds prioritários: B3, NASDAQ, Forex, cripto ou outros.
- Confirmar se a busca deve privilegiar país/bolsa específicos, como Brasil/BMFBOVESPA.
- Confirmar se haverá lista de usuários autorizados.

Critério de aceite: exemplos de alerta são compreendidos sem ambiguidade.

### Fase 2 — Núcleo funcional

- Criar `Alert`, `AlertService` e `AlertRepository`.
- Persistir estado `active`, `notifying` e `triggered`.
- Implementar claim transacional para não disparar o mesmo alerta duas vezes.
- Recuperar claims abandonados após uma reinicialização.

Critério de aceite: testes unitários cobrem os limites `==`, `<` e `>` e uma segunda atualização não envia segunda mensagem.

### Fase 3 — Integração de mercado

- Usar `getQuote` para validar o símbolo no momento do cadastro.
- Usar `searchMarkets` para sugerir símbolos qualificados antes do cadastro.
- Usar `watchQuotes` para acompanhar todos os símbolos ativos em um watcher.
- Reiniciar o watcher quando a lista de símbolos mudar.
- Reconectar após falha do WebSocket com backoff inicial de 10 segundos.

Critério de aceite: um alerta com símbolo válido recebe atualizações; símbolo inválido é rejeitado no cadastro.

### Fase 4 — Telegram

- `/newalert` com botões de ação/moeda.
- Pesquisar/listar símbolos e selecionar o ticker qualificado por botão.
- Na criação de alertas, mostrar listas reais paginadas de ações e pares de moedas, sem rotulá-las como sugestões.
- Coletar preço-alvo e direção.
- Listar ações por bolsa com paginação.
- Consultar cotação atual de ações e moedas.
- Para moedas, selecionar moeda base e moeda de destino e exibir a taxa convertida.
- `/alerts`, `/delete ID`, `/cancel` e `/help`.
- Escapar valores enviados em HTML para evitar formatação indevida.

Critério de aceite: fluxo completo funciona em chat privado e os dados continuam após reiniciar o processo.

### Fase 5 — Produção

- Restringir chats autorizados, se necessário.
- Mover segredos para um secret manager.
- Adicionar métricas: watcher conectado, símbolos acompanhados, alertas disparados e falhas de envio.
- Configurar backup, retenção e teste de restauração do MongoDB.
- Avaliar PostgreSQL se houver múltiplas instâncias ou alto volume.

## Checklist de validação

### Automatizado

```bash
npm run typecheck
npm test
npm run build
```

Ou:

```bash
npm run check
```

### Manual

1. Copiar `.env.example` para `.env` e configurar o token.
2. Iniciar com `npm run dev`.
3. Enviar `/start` no Telegram.
4. Criar uma ação conhecida com preço-alvo próximo do preço atual.
5. Repetir para `FX:EURUSD` ou outro símbolo Forex disponível.
6. Conferir `/alerts` e remover um alerta com `/delete ID`.
7. Forçar o processo a reiniciar e conferir se os alertas ativos continuam no banco.
8. Interromper a rede por alguns segundos e confirmar a reconexão no log.

### Riscos conhecidos

- A disponibilidade, latência e precisão do feed dependem da TradingView, do acesso da conta e das permissões de mercado.
- Uma cotação pode cruzar o alvo entre duas atualizações e não ser observada pelo stream.
- A URI e as credenciais do MongoDB devem ficar em segredo gerenciado; nunca devem aparecer em logs ou no repositório.
- A disponibilidade e a latência dependem do cluster MongoDB e da rede entre o bot e a nuvem.
- O bot não envia ordens e não deve ser tratado como sistema de execução ou recomendação financeira.
