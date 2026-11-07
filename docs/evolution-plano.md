# Canal Evolution (QR code) + interface pt-BR — plano de implementação

> Branch: `feat/evolution-qr-channel`. Sem push, sem deploy, sem migration rodada
> em produção. Este plano **constrói sobre a fundação já mergeada** em `main`
> (PR #1, `docs/superpowers/plans/2026-08-16-evolution-provider-foundation.md`):
> interface `WhatsAppProvider`, `resolveProvider`, migration `040`, e todos os
> caminhos de envio já passam pelo seam. O que falta é o transporte, a entrada,
> a tela e o resto abaixo.

## 0. Desvios do prompt original (decisões já tomadas no repositório)

| Prompt pedia | O que o repositório já decidiu | Plano |
|---|---|---|
| Tabela própria `evolution_config` | D2 da fundação: reusar `whatsapp_config`, coluna `provider`, `phone_number_id` já é nullable, CHECK `whatsapp_config_provider_fields_check` já existe (migration 040, mergeada) | Mantido. A migration 041 só **acrescenta colunas** à mesma linha e amplia o CHECK. Uma tabela paralela duplicaria RLS/escopo e contradiria uma decisão mergeada. |
| API key cifrada em coluna própria | D3: a credencial vai em `access_token` (AES-256-GCM, `encryption.ts`); `provider` desambigua | Mantido. |
| Rota `/api/evolution/*` para tudo | Layout herdado: gerenciamento em `/api/whatsapp/evolution/*` (o middleware já exige sessão em `/api/whatsapp/*`), webhook em `/api/evolution/webhook/[secret]` (fora do gate, com segredo próprio) | Seguido. |
| `QRCODE_UPDATED` atualiza o QR da tela | D9: o QR **nunca é persistido** (credencial de pareamento, expira em ~20 s) | O webhook só marca `connecting`. A tela faz polling em `GET /api/whatsapp/evolution/connect`, que pede um QR novo ao Evolution a cada chamada. Diferença registrada. |
| `sendTypingIndicator` em `auto-reply.ts` | Esta base não tem esse indicador (`auto-reply.ts` envia por `engineSendText`) | O "digitando" entra no provedor Evolution: todo `sendText` manda `delay` (Evolution mostra "digitando…" pelo tempo do delay) + `sendPresence` exposto no cliente. `auto-reply.ts` **não é tocado**. |
| `messages/es.json` | O repositório tem `en`, `ko`, `pt`, `pt-BR` (sem `es`); o teste de paridade cobre `ko`, `pt-BR`, `pt` | Chaves novas vão nos 4 arquivos existentes. `pt.json` e `pt-BR.json` hoje são idênticos; manteremos os dois sincronizados (o `.env` usa `pt`). |
| `.env.example` | O arquivo se chama `.env.local.example` | Editado esse. |
| Zod | `zod` 4.3.6 só existe como dependência transitiva | Declarado em `package.json` (mesma versão do lockfile — não é pacote novo no `node_modules`). |
| Versão do Evolution | Os placeholders do prompt (`URL`, instância, versão) não foram preenchidos | O cliente suporta o formato v2.x (aninhado e plano no `webhook/set`) e a tela mostra o erro real do servidor. A versão real será confirmada no teste manual (`GET {url}/`). |

## 1. Arquivos novos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/041_evolution_channel.sql` | Colunas novas em `whatsapp_config` (segredo do webhook como hash, número conectado, limites de ritmo/broadcast, fila de envio), CHECK ampliado, função `claim_evolution_send_slot`, tipo de notificação `whatsapp_disconnected` |
| `src/lib/whatsapp/evolution/client.ts` | Cliente HTTP (`fetch`, timeout, erros pt-BR): conectar/QR, estado, logout, webhook set, sendText, sendMedia, sendAudio (PTT), presença, marcar lido, baixar mídia base64 |
| `src/lib/whatsapp/evolution/provider.ts` | `WhatsAppProvider` Evolution: usa o cliente, texto numerado p/ interativo, `sendTemplate` recusa, throttle antiban |
| `src/lib/whatsapp/evolution/jid.ts` | Telefone ↔ JID, resolução de LID, nono dígito BR |
| `src/lib/whatsapp/evolution/payload.ts` | Schemas Zod + conversão do payload do Evolution para `NormalizedInbound` |
| `src/lib/whatsapp/evolution/webhook-handler.ts` | Processa `MESSAGES_UPSERT/UPDATE`, `CONNECTION_UPDATE`, `QRCODE_UPDATED` |
| `src/lib/whatsapp/evolution/secret.ts` | Gera segredo, hash SHA-256, comparação em tempo constante |
| `src/lib/whatsapp/evolution/interactive-text.ts` | Botões/listas → texto numerado + resolução da resposta "1/2/3" |
| `src/lib/whatsapp/evolution/throttle.ts` | Chama `claim_evolution_send_slot` e dorme até o slot |
| `src/lib/whatsapp/inbound.ts` | **Extraído** do webhook da Meta: achar/criar contato e conversa, gravar mensagem idempotente, reações, bump de não lidas, flows, automações, IA, webhooks públicos |
| `src/lib/whatsapp/status-update.ts` | **Extraído** do webhook da Meta: escada de status + espelho em `broadcast_recipients` |
| `src/app/api/evolution/webhook/[secret]/route.ts` | Entrada do Evolution |
| `src/app/api/whatsapp/evolution/{config,connect,disconnect}/route.ts` | Gerenciamento (owner/admin) |
| `src/components/settings/evolution-channel.tsx` | Tela do canal QR (campos, QR, status, desconectar) |
| `docs/evolution-teste-manual.md` | Roteiro de teste ponta a ponta |
| Testes `*.test.ts` ao lado de cada módulo acima | Vitest |

## 2. Arquivos alterados (uma linha cada)

| Arquivo | Mudança |
|---|---|
| `src/app/api/whatsapp/webhook/route.ts` | Passa a importar `inbound.ts` / `status-update.ts` (funções movidas **sem mudar comportamento**); suíte existente continua verde |
| `src/lib/whatsapp/provider/resolve.ts` | Ramo `evolution`: decifra a API key e devolve `evolutionProvider(...)` em vez do 501 |
| `src/lib/whatsapp/provider/types.ts` | Métodos opcionais `sendTyping?` e `markRead?` |
| `src/types/index.ts` | Campos novos no variant `WhatsAppConfigEvolution` |
| `src/components/settings/whatsapp-config.tsx` | Seletor "API oficial (Meta)" / "QR code (Evolution)"; no Evolution renderiza `evolution-channel.tsx` |
| `src/components/inbox/message-composer.tsx`, `message-thread.tsx` | Sem janela de 24 h quando o canal é Evolution |
| `src/app/api/whatsapp/broadcast/route.ts`, `src/lib/whatsapp/broadcast-core.ts` | Evolution: só texto/mídia livres, limite de destinatários, ritmo |
| `src/components/broadcasts/*`, `template-manager.tsx` | Esconde/desabilita o que depende de WABA, aviso de banimento |
| `src/app/api/whatsapp/config/route.ts` | Role gate (owner/admin) no POST/DELETE e limpeza das colunas Evolution ao trocar para Meta |
| `messages/{en,ko,pt,pt-BR}.json` | Chaves novas + revisão pt-BR |
| `.env.local.example`, `README.md` | `NEXT_PUBLIC_APP_LOCALE=pt` e seção "Canal Evolution (QR code)" |
| `package.json`, `package-lock.json` | `zod` declarado |

## 3. Migration `041_evolution_channel.sql`

Colunas em `whatsapp_config` (todas `NULL`/default; **só** linhas Evolution as usam — o CHECK força `NULL` nas linhas Meta):

- `evolution_webhook_secret_hash TEXT` — SHA-256 do segredo (índice único). O segredo em claro só existe na URL registrada no Evolution; o banco guarda o hash, então um vazamento da tabela não permite forjar eventos.
- `evolution_phone TEXT` — número conectado (dígitos).
- `evolution_min_interval_ms INT DEFAULT 6000`, `evolution_jitter_ms INT DEFAULT 4000` — ritmo entre envios para números diferentes.
- `evolution_broadcast_max INT DEFAULT 50` — teto de destinatários por disparo.
- `evolution_next_send_at TIMESTAMPTZ`, `evolution_last_to TEXT` — estado da fila antiban.
- Função `claim_evolution_send_slot(account_id, to, now)`: `SECURITY DEFINER`, só `service_role` executa. Reserva atomicamente o próximo slot (serializa envios entre instâncias serverless) e devolve quando enviar; mesmo destinatário da última mensagem não espera.
- `notifications.type` passa a aceitar `whatsapp_disconnected`.
- RLS: nada novo — `whatsapp_config` mantém as policies de conta; as colunas novas herdam. O hash do segredo **não** é lido pelo cliente (a tela usa rotas server-side com `select` explícito).

## 4. Mapeamento Evolution → modelo interno

| Evento Evolution (`event`) | Efeito |
|---|---|
| `messages.upsert`, `fromMe=false` | `NormalizedInbound` → `ingestInbound` (contato, conversa, mensagem `customer`/`delivered`, não lidas, flows, automações, IA, webhooks públicos) |
| `messages.upsert`, `fromMe=true` | Mesma gravação, `sender_type='agent'`, `status='sent'`, **sem** flows/automações/IA/não lidas; dedupe por `message_id` (índice único da 037) com espera curta para o envio do próprio wacrm gravar primeiro |
| `messages.update` | `SERVER_ACK→sent`, `DELIVERY_ACK→delivered`, `READ`/`PLAYED→read`, `ERROR→failed`, só avanço na escada; espelha `broadcast_recipients` |
| `connection.update` | `open→connected` (+ número via `fetchInstances`), `connecting→connecting`, `close→disconnected` + notificação para owner/admin |
| `qrcode.updated` | Marca `connecting` (QR não é persistido — ver §0) |

Tipos de mensagem: `conversation`, `extendedTextMessage`, `imageMessage`, `videoMessage`, `audioMessage` (inclui `ptt`), `documentMessage`, `stickerMessage` → `image`, `locationMessage`, `contactMessage`/`contactsArrayMessage` → texto, `reactionMessage` → `message_reactions`, `buttonsResponseMessage`/`listResponseMessage` → `interactive`. Desconhecido → texto `[tipo não suportado]`. Grupos (`@g.us`), `status@broadcast` e newsletters são ignorados. `@lid` usa `key.remoteJidAlt` / `senderPn`; sem número real a mensagem é descartada com log (nunca cria contato com LID como telefone). Brasil: `55` + DDD + 9 dígitos é a forma canônica — um celular sem o nono dígito é normalizado para a forma com 9, e `findExistingContact` (sufixo de 8 dígitos) evita duplicar.

Mídia: `chat/getBase64FromMediaMessage` → bytes → upload no bucket `chat-media` pelo **mesmo** caminho de `mirror-inbound-media.ts` (refatorado minimamente para aceitar bytes já baixados); falha de mídia nunca derruba a mensagem.

## 5. Ordem de execução (um commit por fase)

1. **Fase 1** — pt-BR: `.env.local.example`, revisão `pt.json`/`pt-BR.json`, textos fixos, datas/moeda.
2. **Fase 2** — migration 041, cliente, config/connect/disconnect, tela.
3. **Fase 3** — extração `inbound.ts`/`status-update.ts`, webhook Evolution.
4. **Fase 4** — provedor Evolution, throttle, interativo numerado.
5. **Fase 5** — gating Meta-only, janela 24 h, broadcast Evolution.
6. Testes, `docs/evolution-teste-manual.md`, README, verificação final (`typecheck`, `lint`, `test`, `build`).

## 6. Baseline de testes

Registrada antes da primeira mudança (ver commit da Fase 1). A fundação documenta 5 falhas pré-existentes dependentes de locale/fuso (`currency.test.ts`, `dashboard/date-utils.test.ts`); o alvo é **nenhuma falha nova**.
