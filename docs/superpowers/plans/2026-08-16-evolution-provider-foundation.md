# Fundação do Provedor de WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a camada de provedor de WhatsApp e a migração de schema que a sustenta, mantendo o comportamento 100% idêntico ao de hoje (só Meta), para que a Evolution API possa ser plugada depois sem tocar em nenhum dos cinco caminhos de envio.

**Architecture:** Hoje o bloco "carregar contato → sanitizar telefone → carregar `whatsapp_config` → `decrypt` → chamar Meta → retry por variante de telefone → persistir em `messages` → atualizar `conversations`" está copiado em quatro arquivos. Este plano extrai **só a parte que difere entre provedores** — o transporte e a política de retry de endereço — para uma interface `WhatsAppProvider`, e deixa a persistência onde está. Um `resolveProvider(db, accountId)` lê a config, descriptografa a credencial e devolve o provedor já vinculado. A migração `040` adiciona a coluna `provider` e afrouxa as colunas específicas da Meta.

**Tech Stack:** TypeScript, Next.js 16 (App Router), Supabase (Postgres 17), Vitest.

---

## Contexto que o implementador precisa ter

**Este plano não adiciona nenhuma funcionalidade.** O critério de saída é a suíte verde com zero mudança de comportamento. Se um teste de comportamento mudar de resultado, o refactor está errado.

**Baseline da suíte, medido em 2026-08-16 antes de qualquer mudança:**

```
Test Files  2 failed | 77 passed (79)
     Tests  5 failed | 824 passed (829)
```

As 5 falhas são **pré-existentes e não relacionadas** — dependem do locale/fuso da máquina (`src/lib/currency.test.ts` espera formatação `en-US` e `src/lib/dashboard/date-utils.test.ts` parseia `new Date("2026-05-18")` como UTC). Não tente consertá-las neste plano. O alvo ao final é **exatamente as mesmas 5 falhas, nenhuma nova**.

**Decisões já congeladas (não reabrir):**

| # | Decisão |
|---|---|
| D1 | Um provedor por conta por vez. `UNIQUE(account_id)` fica como está; trocar de provedor reescreve a mesma linha. |
| D2 | Reusar a tabela `whatsapp_config`. Sem tabela nova. |
| D3 | A credencial da Evolution vai na coluna `access_token` existente, cifrada pelo mesmo `encrypt()`. A coluna `provider` desambigua o conteúdo. |
| D9 | `status` ganha o valor `connecting`. O QR **nunca** é persistido. |

**Estilo:** o repo mistura ponto-e-vírgula (`send-message.ts`) e sem (`flows/meta-send.ts`). Formate **só os arquivos da task** com `npx prettier --write <arquivos>`. **NUNCA rode `npm run format`** — ele varre o repo inteiro e, como há drift pré-existente de estilo, reescreve ~360 arquivos não relacionados (descoberto na Task 2). Uma limpeza dedicada de formatação fica fora deste plano.

**Os seis sites que serão migrados:**

| Arquivo | Função | O que envia | Semântica do retry |
|---|---|---|---|
| `src/lib/whatsapp/send-message.ts` | `sendMessageToConversation` | text, template, media, interactive | **lança** ao esgotar |
| `src/lib/flows/meta-send.ts` | `engineSendText`, `engineSendMedia`, `sendInteractiveViaMeta` | text, media, interactive | **lança** ao esgotar |
| `src/lib/automations/meta-send.ts` | `sendViaMeta` | text, template | **lança** ao esgotar |
| `src/lib/whatsapp/broadcast-core.ts` | `deliverBroadcast` | template | **`break`** — best-effort por destinatário |
| `src/app/api/whatsapp/broadcast/route.ts` | `POST` (envio inline) | template | **`break`** — best-effort por destinatário |
| `src/app/api/whatsapp/react/route.ts` | `POST` | reaction | sem retry |

**A diferença de semântica na coluna da direita é crítica.** Os quatro primeiros propagam o erro; os dois caminhos de broadcast fazem `break` e registram `lastError` por destinatário, porque uma falha nunca pode abortar as outras 4.999. Por isso `sendWithAddressRetry` (que lança) **não é drop-in** nos broadcasts — lá o loop permanece, trocando apenas as funções de política pelas do provedor. Trocar isso por um helper que lança transformaria um broadcast parcialmente falho num broadcast abortado.

---

## File Structure

**Criar:**

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/040_evolution_provider.sql` | Coluna `provider`, colunas Evolution, afrouxar `phone_number_id`, ampliar CHECK de `status` |
| `src/lib/whatsapp/provider/types.ts` | A interface `WhatsAppProvider` e os tipos de argumento. Sem lógica. |
| `src/lib/whatsapp/provider/meta.ts` | Implementação Meta — embrulha `meta-api.ts`, nada de novo |
| `src/lib/whatsapp/provider/retry.ts` | `sendWithAddressRetry` — o loop de retry hoje copiado 4× |
| `src/lib/whatsapp/provider/resolve.ts` | `resolveProvider(db, accountId)` — carrega config, descriptografa, devolve provedor |
| `src/lib/whatsapp/provider/meta.test.ts` | Testes do provedor Meta |
| `src/lib/whatsapp/provider/retry.test.ts` | Testes do retry |
| `src/lib/whatsapp/provider/resolve.test.ts` | Testes da resolução |

**Modificar:**

| Arquivo | Mudança |
|---|---|
| `supabase/ci/verify-schema.sql` | Assertion da coluna `provider`, dentro do bloco `DO` existente |
| `src/types/index.ts:275-302` | `WhatsAppConfig` vira união discriminada por `provider` |
| `src/lib/whatsapp/send-message.ts` | Usa `resolveProvider` + `sendWithAddressRetry` |
| `src/lib/flows/meta-send.ts` | idem, nas três funções |
| `src/lib/automations/meta-send.ts` | idem, em `sendViaMeta` |
| `src/lib/whatsapp/broadcast-core.ts` | `BroadcastPlan` carrega o provedor; loop mantém o `break` |
| `src/lib/whatsapp/broadcast-resume.ts` | idem, se montar seu próprio `BroadcastPlan` |
| `src/app/api/whatsapp/broadcast/route.ts` | envio inline próprio; loop mantém o `break` |
| `src/app/api/whatsapp/react/route.ts` | `provider.sendReaction`, sem retry |

---

### Task 1: Migração 040 — schema do provedor

**Files:**
- Create: `supabase/migrations/040_evolution_provider.sql`
- Modify: `supabase/ci/verify-schema.sql`

- [ ] **Step 1: Escrever a migração**

Crie `supabase/migrations/040_evolution_provider.sql`:

```sql
-- ============================================================
-- 040_evolution_provider
--
-- Prepara o schema para um segundo provedor de WhatsApp (Evolution
-- API / Baileys) ao lado da Meta Cloud API.
--
-- Decisão de escopo: UM provedor por conta POR VEZ. O
-- `UNIQUE(account_id)` da migração 017 continua valendo — trocar de
-- provedor reescreve a mesma linha, não cria uma segunda. Coexistência
-- (Meta e Evolution ativos juntos na mesma conta) foi deliberadamente
-- adiada; abrir isso depois é trocar a constraint por
-- UNIQUE(account_id, provider), e essa migração não fecha essa porta.
--
-- Cinco mudanças:
--
--   1. `provider` — o discriminador. DEFAULT 'meta' porque toda linha
--      existente É Meta; sem o default, a coluna NOT NULL não poderia
--      ser adicionada a uma tabela populada.
--
--   2. `evolution_url` / `evolution_instance` — os dois campos que a
--      Evolution precisa e a Meta não tem. A CREDENCIAL não ganha
--      coluna nova: vai no `access_token` existente, que já é cifrado
--      com AES-256-GCM por `src/lib/whatsapp/encryption.ts` e já tem o
--      caminho de auto-upgrade de ciphertext CBC legado. A coluna
--      `provider` diz o que está lá dentro.
--
--      Uma `evolution_api_key` dedicada foi considerada e recusada.
--      Ela é mais legível, mas obriga a derrubar o `NOT NULL` de
--      `access_token` (uma linha Evolution o deixaria vazio) e cria
--      uma SEGUNDA coluna cifrada, que o auto-upgrade de ciphertext
--      legado não conhece — ou seja, um caminho de criptografia sem
--      manutenção. Reusar a coluna mantém uma constraint intacta e um
--      único lugar onde segredo é cifrado.
--
--      O preço é que `provider` vira LOAD-BEARING: descriptografar
--      `access_token` sem checar `provider` entrega o segredo do
--      provedor errado — e sete rotas exclusivas da Meta (templates,
--      proxy de mídia, registro, webhook) mandariam a chave da
--      Evolution para graph.facebook.com. A contenção tem duas metades:
--      os caminhos de ENVIO passam a ler só via `resolveProvider()`, e
--      os que sobram ganham `assertMetaConfig()` (Task 13), que falha
--      alto antes de descriptografar.
--
--   3. `phone_number_id` deixa de ser NOT NULL. Uma conexão Evolution
--      não conhece o número antes do QR ser lido, e depois de lido o
--      valor não é um phone_number_id da Meta. O `UNIQUE` da migração
--      013 NÃO precisa mudar: Postgres trata NULLs como distintos por
--      padrão (a constraint não usa NULLS NOT DISTINCT), então N linhas
--      Evolution com NULL convivem sem colidir.
--
--   4. `status` ganha 'connecting'. O Baileys tem um estado
--      intermediário real (socket abrindo, QR pendente) que a Meta não
--      tem, e o CHECK de duas posições da 001 não tem onde guardá-lo.
--
--   5. `whatsapp_config_provider_fields_check` — cada linha carrega os
--      campos do SEU provedor e NENHUM do outro. As metades negativas
--      importam tanto quanto as positivas: trocar de provedor reescreve
--      a mesma linha (decisão D1), então colunas residuais do provedor
--      anterior seriam o estado NORMAL, não acidente — e um
--      `phone_number_id` residual numa linha Evolution continuaria
--      roteável pelo webhook da Meta e continuaria reivindicando o
--      número no UNIQUE da migração 013. O CHECK torna o híbrido
--      irrepresentável; a troca de provedor é obrigada a limpar a
--      identidade do provedor anterior na mesma escrita. Vale para
--      TODAS as colunas Meta-only — inclusive `verify_token`, que é um
--      segredo, e os carimbos de registro da migração 015 — não só
--      para as três que dão nome às branches.
--
-- O QR Code NÃO ganha coluna. Ele é credencial de pareamento de
-- dispositivo e expira em ~20s; será servido por rota autenticada e
-- nunca persistido.
-- ============================================================

-- 1. Discriminador de provedor.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'evolution'));
  END IF;
END $$;

-- 2. Campos específicos da Evolution. Nullable: uma linha Meta não os usa.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_url      TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance TEXT;

-- 3. phone_number_id deixa de ser obrigatório.
ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL;

-- 4. status ganha 'connecting'. Não há ADD/DROP condicional para CHECK,
--    então derruba e recria — o nome vem do autogerado da migração 001.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'disconnected', 'connecting'));

-- 5. Integridade por provedor: cada linha carrega os campos do SEU
--    provedor. Sem isso, uma linha Evolution com evolution_url NULL
--    passa pelo INSERT e só falha na hora do primeiro envio.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_fields_check
      CHECK (
        (provider = 'meta'      AND phone_number_id IS NOT NULL
                                AND evolution_url IS NULL
                                AND evolution_instance IS NULL)
        OR
        (provider = 'evolution' AND evolution_url IS NOT NULL
                                AND evolution_instance IS NOT NULL
                                AND phone_number_id IS NULL
                                AND waba_id IS NULL
                                AND verify_token IS NULL
                                AND registered_at IS NULL
                                AND subscribed_apps_at IS NULL
                                AND last_registration_error IS NULL)
      );
  END IF;
END $$;

-- Documentação de catálogo — mesmo padrão das migrações 038/039, para
-- o fato mais surpreendente do schema ficar visível num \d+ e não só
-- enterrado neste arquivo.
COMMENT ON COLUMN whatsapp_config.provider IS
  'Transporte de WhatsApp da conta: ''meta'' (Cloud API) ou ''evolution'' (Baileys). Determina o que access_token contém.';
COMMENT ON COLUMN whatsapp_config.evolution_url IS
  'Base URL do servidor Evolution API. Preenchida só quando provider=''evolution''.';
COMMENT ON COLUMN whatsapp_config.evolution_instance IS
  'Nome da instância no servidor Evolution. Preenchido só quando provider=''evolution''.';
```

- [ ] **Step 2: Adicionar a assertion no CI**

Em `supabase/ci/verify-schema.sql`, dentro do bloco `DO $$ ... END $$` que já existe (o arquivo aceita **exatamente uma** statement — não crie um segundo bloco), adicione antes do `END $$;` final:

```sql
  -- 040: a coluna de provedor precisa existir E aceitar 'evolution'.
  -- Testar só a existência da coluna deixaria passar um CHECK escrito
  -- errado, que é o modo de falha que interessa aqui.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'whatsapp_config'
      AND column_name = 'provider'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.provider is missing — migration 040 did not apply';
  END IF;

  -- (As duas sondas rodam como postgres, dono da tabela — RLS não se
  --  aplica. Se o CI um dia trocar de papel, elas falhariam com
  --  insufficient_privilege, e a causa seria o harness, não a 040.)
  BEGIN
    INSERT INTO whatsapp_config (user_id, account_id, provider, access_token,
                                 evolution_url, evolution_instance, status)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'evolution', 'x',
            'https://example.invalid', 'ci-probe', 'connecting');
    RAISE EXCEPTION 'CI probe row was accepted but should have been rolled back';
  EXCEPTION
    WHEN foreign_key_violation THEN
      -- Esperado: os UUIDs aleatórios não existem em auth.users/accounts.
      -- Chegar até a violação de FK prova que provider='evolution',
      -- status='connecting' e phone_number_id NULL passaram por todos
      -- os CHECKs — que é exatamente o que a 040 tinha que liberar.
      NULL;
  END;

  -- Sonda negativa: os CHECKs também precisam RECUSAR. Sem ela, um
  -- DO-guard que silenciosamente não criou a constraint continuaria
  -- verde — o exato modo de falha que este arquivo existe para pegar.
  -- check_violation dispara ANTES dos gatilhos de FK.
  -- A ORDEM das sondas é load-bearing: a positiva, rodando antes com o
  -- mesmo status 'connecting', é quem prova que o status_check aceita o
  -- valor — então um check_violation aqui só pode vir do
  -- provider_fields_check. Não reordene.
  BEGIN
    INSERT INTO whatsapp_config (user_id, account_id, provider, access_token, status)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'evolution', 'x', 'connecting');
    RAISE EXCEPTION 'provider_fields_check accepted an evolution row with no evolution_url';
  EXCEPTION
    WHEN check_violation THEN
      NULL; -- esperado
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'provider_fields_check is missing — the bad row sailed past the CHECKs into FK validation';
  END;
```

- [ ] **Step 3: Aplicar e verificar localmente**

Run:
```bash
npx supabase db reset
```

Expected: aplica as 40 migrações sem erro e imprime `Finished supabase db reset.` Se o passo 4 falhar com `constraint "whatsapp_config_status_check" does not exist`, confirme o nome real com `\d whatsapp_config` no psql e ajuste — o `DROP ... IF EXISTS` já tolera a ausência, então isso só aparece se o nome autogerado divergir.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/040_evolution_provider.sql supabase/ci/verify-schema.sql
git commit -m "feat(db): add provider discriminator to whatsapp_config"
```

---

### Task 2: `WhatsAppConfig` vira união discriminada

**Files:**
- Modify: `src/types/index.ts:275-302`

- [ ] **Step 1: Substituir a interface**

Em `src/types/index.ts`, substitua o bloco `export interface WhatsAppConfig { ... }` inteiro por:

```ts
export type WhatsAppProviderKind = 'meta' | 'evolution';

/** Campos comuns aos dois provedores. */
interface WhatsAppConfigBase {
  id: string;
  user_id: string;
  /**
   * Tenancy. NOT NULL desde a migração 017 — o tipo antigo omitia esta
   * coluna, o que deixava `config.account_id` como erro de tipo em
   * código correto.
   */
  account_id: string;
  /** Credencial do provedor, cifrada com AES-256-GCM. Para `meta` é o
   *  access token do Graph; para `evolution` é a API key. Migração 040. */
  access_token: string;
  status: 'connected' | 'disconnected' | 'connecting';
  connected_at?: string;
  created_at?: string;
  updated_at?: string;
  /**
   * When true (the default), the inbound webhook copies received media
   * into the `chat-media` bucket so attachments outlive Meta's ~30-day
   * retention. Turning it off keeps storage flat and accepts that
   * inbound attachments expire. A coluna é NOT NULL DEFAULT TRUE
   * (migração 039); o `?` existe porque uma linha pode ser lida contra
   * um banco que ainda não rodou a 039.
   */
  mirror_inbound_media?: boolean;
}

export interface WhatsAppConfigMeta extends WhatsAppConfigBase {
  provider: 'meta';
  phone_number_id: string;
  waba_id?: string;
  verify_token?: string;
  /**
   * Set when POST /{phone_number_id}/register last succeeded. NULL
   * means the number was saved but never actually subscribed for
   * webhooks on Meta's side — inbound events will be silently lost.
   */
  registered_at?: string;
  /** Set when POST /{waba_id}/subscribed_apps last succeeded. */
  subscribed_apps_at?: string;
  /** Last error from /register; cleared on success. */
  last_registration_error?: string;
}

/**
 * As colunas Meta-only que este variant omite (waba_id, verify_token,
 * registered_at, subscribed_apps_at, last_registration_error) não são
 * só convenção: o CHECK da migração 040 as força a NULL quando
 * provider = 'evolution'.
 */
export interface WhatsAppConfigEvolution extends WhatsAppConfigBase {
  provider: 'evolution';
  /** Base URL do servidor Evolution, ex. `https://evolution.example.com`. */
  evolution_url: string;
  /** Nome da instância no servidor Evolution. */
  evolution_instance: string;
  /** Sempre NULL numa linha Evolution — a coluna existe para a Meta. */
  phone_number_id?: null;
}

export type WhatsAppConfig = WhatsAppConfigMeta | WhatsAppConfigEvolution;
```

- [ ] **Step 2: Ver o que quebrou e deixar o typecheck verde**

Run: `npm run typecheck`

O único consumidor do tipo é `src/components/settings/whatsapp-config.tsx:33-61` (estado `useState<WhatsAppConfigType | null>`) — os caminhos de envio leem linhas cruas do Supabase (`select('*')`, não tipadas) e não quebram. Erros esperados: leituras de campos Meta-only (`waba_id`, `verify_token`, `registered_at`…) sobre a união.

Conserte **já nesta task** (todo commit deve compilar): troque o tipo do estado para a variante Meta —

```ts
import type { WhatsAppConfigMeta } from '@/types';
// ...
const [config, setConfig] = useState<WhatsAppConfigMeta | null>(null);
```

É honesto, não gambiarra: este componente É o painel Meta hoje; o seletor de provedor do plano 3 o reconstrói de qualquer forma.

E, como o client do browser não tem generics do Supabase (`select('*')` devolve `any`), a anotação sozinha é documentação, não enforcement. Torne-a verdadeira no `fetchConfig`: em vez de um `return` antecipado (que pularia o reset de formulário/status e deixaria campos do Meta anterior na tela numa re-busca), trate a linha de outro provedor como ausência de linha, roteando pelo `else` que já existe. Substitua os dois `if (data)` (o do formulário e o do health-check) por:

```ts
      // Linha de outro provedor: este painel é Meta-only até o plano 3.
      // Tratá-la como "sem config" (em vez de retornar cedo) faz o caso
      // passar pelo mesmo reset de formulário/status que a ausência de
      // linha — senão uma re-busca (troca de conta) deixaria campos e
      // badge do Meta anterior na tela.
      const metaRow = data && (data.provider ?? 'meta') === 'meta' ? data : null;

      if (metaRow) {
        setConfig(metaRow);
        setPhoneNumberId(metaRow.phone_number_id || '');
        // ... (resto do bloco inalterado, lendo de metaRow)
```

e `if (metaRow)` no bloco de health-check mais abaixo.

Se aparecer erro em **qualquer outro arquivo**, pare e reporte: é um consumidor que este plano não mapeou.

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "types: make WhatsAppConfig a discriminated union on provider"
```

---

### Task 3: A interface `WhatsAppProvider`

**Files:**
- Create: `src/lib/whatsapp/provider/types.ts`

Sem teste próprio: é só declaração de tipo, e `npm run typecheck` já é o teste. As Tasks 4-6 trazem os testes de comportamento.

- [ ] **Step 1: Escrever o arquivo**

```ts
// ============================================================
// A fronteira entre o CRM e o transporte de WhatsApp.
//
// Só o que DIFERE entre provedores mora aqui. Buscar o contato,
// persistir em `messages` e atualizar `conversations` é idêntico nos
// dois casos e continua nos chamadores — mover isso para cá teria
// transformado um refactor de transporte numa reescrita da camada de
// dados.
//
// `addressVariants` e `isRetryableAddressError` são parte da interface
// porque o retry de variante de telefone é POLÍTICA DE PROVEDOR, não
// regra de negócio: existe por causa do sandbox da Meta (erro 131030) e
// não faz sentido no Baileys. Deixá-lo hard-coded nos chamadores faria
// a Evolution herdar tentativas inúteis — e, pior, o write-back em
// `contacts.phone` poderia gravar uma variante fabricada por cima do
// telefone real.
// ============================================================

import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '@/lib/whatsapp/meta-api';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate, WhatsAppProviderKind } from '@/types';

/**
 * Alias, não redeclaração: o discriminador tem UMA fonte de verdade
 * (`WhatsAppProviderKind` em `@/types`, ao lado da união de config).
 * Redeclarar o literal aqui criaria dois vocabulários idênticos que
 * divergem no primeiro provedor novo.
 */
export type ProviderKind = WhatsAppProviderKind;

export interface ProviderSendResult {
  /** O id do provedor: `wamid...` na Meta, `key.id` na Evolution. */
  messageId: string;
}

export interface ProviderSendTextArgs {
  to: string;
  text: string;
  contextMessageId?: string;
}

export interface ProviderSendMediaArgs {
  to: string;
  kind: MediaKind;
  link: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}

export interface ProviderSendAudioArgs {
  to: string;
  link: string;
  contextMessageId?: string;
}

export interface ProviderSendTemplateArgs {
  to: string;
  templateName: string;
  language?: string;
  template?: MessageTemplate;
  /**
   * Tipado como `SendTimeParams` (não `unknown`): é o que
   * `sendTemplateMessage` aceita, e um `unknown` aqui obrigaria o
   * adaptador Meta a um cast — além de jogar fora a checagem que a
   * rota de broadcast já tem hoje.
   */
  messageParams?: SendTimeParams;
  params?: string[];
  contextMessageId?: string;
}

export interface ProviderSendInteractiveButtonsArgs {
  to: string;
  bodyText: string;
  buttons: InteractiveButton[];
  headerText?: string;
  footerText?: string;
  contextMessageId?: string;
}

export interface ProviderSendInteractiveListArgs {
  to: string;
  bodyText: string;
  buttonLabel: string;
  sections: InteractiveListSection[];
  headerText?: string;
  footerText?: string;
  contextMessageId?: string;
}

export interface ProviderSendReactionArgs {
  to: string;
  /**
   * Mensagem sendo reagida, no id do provedor. O nome do campo segue
   * `sendReactionMessage` em `meta-api.ts:680` — `targetMessageId`,
   * não `messageId` — para o adaptador ser repasse puro.
   */
  targetMessageId: string;
  /** Emoji, ou string vazia para remover a reação. */
  emoji: string;
}

export interface WhatsAppProvider {
  readonly kind: ProviderKind;

  /**
   * Endereços a tentar, em ordem, para um telefone JÁ SANITIZADO
   * (só dígitos, sem `+` — o que `sanitizePhoneForMeta` devolve). A
   * Meta devolve variantes de trunk-0 (sandbox); provedores sem essa
   * quirk devolvem um único elemento. Passar um E.164 com `+` produz
   * variantes inúteis: os chamadores sanitizam antes.
   */
  addressVariants(phone: string): string[];

  /**
   * True quando o erro significa "tente o próximo endereço".
   *
   * Recebe o erro CRU (`unknown`), não a mensagem: hoje `meta-api.ts`
   * lança `new Error(prose)` e o predicado da Meta procura o código
   * 131030 no texto — mas um provedor que exponha status HTTP ou corpo
   * JSON estruturado precisa poder decidir por eles, sem ser obrigado
   * a traduzir seus erros para inglês-da-Meta. Cada provedor stringifica
   * do jeito que precisar.
   */
  isRetryableAddressError(error: unknown): boolean;

  sendText(args: ProviderSendTextArgs): Promise<ProviderSendResult>;
  sendMedia(args: ProviderSendMediaArgs): Promise<ProviderSendResult>;
  /**
   * Nota de voz (PTT). Existe separado de `sendMedia` porque os dois
   * provedores tratam áudio de formas diferentes: a Meta manda pelo
   * mesmo endpoint de mídia com `type: audio`, enquanto a Evolution
   * tem `POST /message/sendWhatsAppAudio/{instance}`, que é o que faz
   * o WhatsApp renderizar como gravação de microfone em vez de
   * arquivo anexado. Colapsar os dois em `sendMedia` obrigaria o
   * provedor Evolution a inspecionar `kind` e desviar — o desvio fica
   * aqui, explícito na interface.
   *
   * Nenhum chamador usa isto ainda: hoje todos mandam áudio por
   * `sendMedia({ kind: 'audio' })`, e este plano NÃO os muda. O método
   * existe para o provedor Evolution do plano 2 ter onde encaixar.
   */
  sendAudio(args: ProviderSendAudioArgs): Promise<ProviderSendResult>;
  sendTemplate(args: ProviderSendTemplateArgs): Promise<ProviderSendResult>;
  sendInteractiveButtons(
    args: ProviderSendInteractiveButtonsArgs
  ): Promise<ProviderSendResult>;
  sendInteractiveList(
    args: ProviderSendInteractiveListArgs
  ): Promise<ProviderSendResult>;
  /**
   * Devolve `ProviderSendResult` como os demais: `sendReactionMessage`
   * já retorna o wamid da reação, e descartá-lo aqui só criaria uma
   * exceção de forma na interface. O chamador atual ignora o valor.
   */
  sendReaction(args: ProviderSendReactionArgs): Promise<ProviderSendResult>;
}
```

- [ ] **Step 2: Verificar que compila**

Run: `npm run typecheck`

Expected: nenhum erro **novo** além dos herdados da Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/lib/whatsapp/provider/types.ts
git commit -m "feat(provider): declare the WhatsAppProvider interface"
```

---

### Task 4: Implementação Meta do provedor

**Files:**
- Create: `src/lib/whatsapp/provider/meta.ts`
- Test: `src/lib/whatsapp/provider/meta.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Crie `src/lib/whatsapp/provider/meta.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.TEXT' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.MEDIA' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.TPL' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.BTN' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.LIST' })),
  sendReactionMessage: vi.fn(async () => ({ messageId: 'wamid.REACT' })),
}));

import * as metaApi from '@/lib/whatsapp/meta-api';
import { phoneVariants } from '@/lib/whatsapp/phone-utils';
import { metaProvider } from './meta';

const CREDS = { phoneNumberId: 'pn-1', accessToken: 'tok-1' };

describe('metaProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('identifies as meta', () => {
    expect(metaProvider(CREDS).kind).toBe('meta');
  });

  it('forwards credentials and args to sendTextMessage', async () => {
    const result = await metaProvider(CREDS).sendText({
      to: '37063949836',
      text: 'oi',
      contextMessageId: 'wamid.PARENT',
    });

    expect(result).toEqual({ messageId: 'wamid.TEXT' });
    expect(metaApi.sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      text: 'oi',
      contextMessageId: 'wamid.PARENT',
    });
  });

  it('forwards media args including filename and caption', async () => {
    await metaProvider(CREDS).sendMedia({
      to: '37063949836',
      kind: 'document',
      link: 'https://example.com/a.pdf',
      caption: 'contrato',
      filename: 'a.pdf',
    });

    expect(metaApi.sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      kind: 'document',
      link: 'https://example.com/a.pdf',
      caption: 'contrato',
      filename: 'a.pdf',
      contextMessageId: undefined,
    });
  });

  // O retry de trunk-0 é política da Meta e tem que continuar sendo dela.
  // Este teste afirma a DELEGAÇÃO, não a lista de variantes — a lista
  // já é coberta por phone-utils.test.ts e duplicá-la aqui só criaria
  // um segundo lugar para atualizar quando a heurística mudar.
  it('delegates its address policy to phoneVariants', () => {
    const variants = metaProvider(CREDS).addressVariants('37063949836');

    expect(variants).toEqual(phoneVariants('37063949836'));
    // Sanidade: a política da Meta produz mais de um candidato.
    expect(variants.length).toBeGreaterThan(1);
    expect(variants[0]).toBe('37063949836');
  });

  // sendAudio existe para a Evolution ter onde encaixar o endpoint
  // dedicado de PTT. Na Meta é o mesmo endpoint de mídia — e este
  // teste trava esse mapeamento para ninguém "otimizar" o método fora.
  it('maps sendAudio onto the Meta media endpoint with kind=audio', async () => {
    await metaProvider(CREDS).sendAudio({
      to: '37063949836',
      link: 'https://example.com/nota.ogg',
    });

    expect(metaApi.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok-1',
        to: '37063949836',
        kind: 'audio',
        link: 'https://example.com/nota.ogg',
      })
    );
  });

  // Recebe o erro cru: Error, string, ou qualquer coisa que um fetch
  // rejeitado possa lançar. Só o texto do 131030 é retryable.
  it('treats Meta error 131030 as a retryable address error', () => {
    const p = metaProvider(CREDS);
    expect(p.isRetryableAddressError(new Error('(#131030) not in allowed list'))).toBe(true);
    expect(p.isRetryableAddressError('recipient not in the allowed list')).toBe(true);
    expect(p.isRetryableAddressError(new Error('rate limit hit'))).toBe(false);
    expect(p.isRetryableAddressError(undefined)).toBe(false);
  });

  // Os três forwards mais pesados. Um typo de campo o TS pega (excess
  // property check); um CROSS-WIRE de campos do mesmo tipo — header no
  // footer, templateName no language — compila em silêncio. Estes
  // testes existem para esse caso, e sendTemplate é o caminho de
  // broadcast, o de maior volume do app.
  it('forwards every template field, including messageParams', async () => {
    const template = { id: 't-1', name: 'promo' } as never;
    const messageParams = { body: ['Ana'] } as never;
    await metaProvider(CREDS).sendTemplate({
      to: '37063949836',
      templateName: 'promo',
      language: 'pt_BR',
      template,
      messageParams,
      params: ['Ana'],
      contextMessageId: 'wamid.PARENT',
    });

    expect(metaApi.sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      templateName: 'promo',
      language: 'pt_BR',
      template,
      messageParams,
      params: ['Ana'],
      contextMessageId: 'wamid.PARENT',
    });
  });

  it('forwards interactive-button fields without cross-wiring header/footer', async () => {
    const buttons = [{ id: 'b1', title: 'Sim' }];
    await metaProvider(CREDS).sendInteractiveButtons({
      to: '37063949836',
      bodyText: 'Confirma?',
      buttons,
      headerText: 'HEADER',
      footerText: 'FOOTER',
    });

    expect(metaApi.sendInteractiveButtons).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      bodyText: 'Confirma?',
      buttons,
      headerText: 'HEADER',
      footerText: 'FOOTER',
      contextMessageId: undefined,
    });
  });

  it('forwards interactive-list fields without cross-wiring header/footer', async () => {
    const sections = [{ title: 'S', rows: [{ id: 'r1', title: 'Um' }] }];
    await metaProvider(CREDS).sendInteractiveList({
      to: '37063949836',
      bodyText: 'Escolha',
      buttonLabel: 'Ver',
      sections,
      headerText: 'HEADER',
      footerText: 'FOOTER',
    });

    expect(metaApi.sendInteractiveList).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      bodyText: 'Escolha',
      buttonLabel: 'Ver',
      sections,
      headerText: 'HEADER',
      footerText: 'FOOTER',
      contextMessageId: undefined,
    });
  });

  it('returns the reaction wamid instead of discarding it', async () => {
    const result = await metaProvider(CREDS).sendReaction({
      to: '37063949836',
      targetMessageId: 'wamid.TARGET',
      emoji: '👍',
    });

    expect(result).toEqual({ messageId: 'wamid.REACT' });
    expect(metaApi.sendReactionMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      targetMessageId: 'wamid.TARGET',
      emoji: '👍',
    });
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/provider/meta.test.ts`

Expected: FAIL com `Failed to resolve import "./meta"`.

- [ ] **Step 3: Escrever a implementação**

Crie `src/lib/whatsapp/provider/meta.ts`:

```ts
// ============================================================
// Provedor Meta Cloud API.
//
// Adaptador puro sobre `meta-api.ts`: nenhuma regra nova, nenhuma
// chamada de rede própria. A única coisa que ele acrescenta é vincular
// `phoneNumberId` + `accessToken` uma vez, em vez de repassá-los em
// cada chamada — que era o motivo de os quatro caminhos de envio
// precisarem carregar a config inteira até o ponto do fetch.
// ============================================================

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type {
  WhatsAppProvider,
  ProviderSendTextArgs,
  ProviderSendMediaArgs,
  ProviderSendAudioArgs,
  ProviderSendTemplateArgs,
  ProviderSendInteractiveButtonsArgs,
  ProviderSendInteractiveListArgs,
  ProviderSendReactionArgs,
  ProviderSendResult,
} from './types';

export interface MetaCredentials {
  phoneNumberId: string;
  /** Já descriptografado. */
  accessToken: string;
}

export function metaProvider(creds: MetaCredentials): WhatsAppProvider {
  const { phoneNumberId, accessToken } = creds;
  const auth = { phoneNumberId, accessToken };

  return {
    kind: 'meta',

    addressVariants: (phone: string) => phoneVariants(phone),
    // Stringifica aqui — a mesma linha que os quatro chamadores tinham
    // antes do check. É política da Meta procurar o 131030 no texto.
    isRetryableAddressError: (error: unknown) =>
      isRecipientNotAllowedError(
        error instanceof Error ? error.message : String(error)
      ),

    async sendText(args: ProviderSendTextArgs): Promise<ProviderSendResult> {
      return sendTextMessage({
        ...auth,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendMedia(args: ProviderSendMediaArgs): Promise<ProviderSendResult> {
      return sendMediaMessage({
        ...auth,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      });
    },

    // A Meta não distingue nota de voz de arquivo de áudio no envio —
    // é o mesmo endpoint com `type: audio`. O desvio existe para a
    // Evolution, que tem endpoint dedicado.
    async sendAudio(args: ProviderSendAudioArgs): Promise<ProviderSendResult> {
      return sendMediaMessage({
        ...auth,
        to: args.to,
        kind: 'audio',
        link: args.link,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendTemplate(
      args: ProviderSendTemplateArgs
    ): Promise<ProviderSendResult> {
      return sendTemplateMessage({
        ...auth,
        to: args.to,
        templateName: args.templateName,
        language: args.language,
        template: args.template,
        messageParams: args.messageParams,
        params: args.params,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendInteractiveButtons(
      args: ProviderSendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      return sendInteractiveButtons({
        ...auth,
        to: args.to,
        bodyText: args.bodyText,
        buttons: args.buttons,
        headerText: args.headerText,
        footerText: args.footerText,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendInteractiveList(
      args: ProviderSendInteractiveListArgs
    ): Promise<ProviderSendResult> {
      return sendInteractiveList({
        ...auth,
        to: args.to,
        bodyText: args.bodyText,
        buttonLabel: args.buttonLabel,
        sections: args.sections,
        headerText: args.headerText,
        footerText: args.footerText,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendReaction(
      args: ProviderSendReactionArgs
    ): Promise<ProviderSendResult> {
      return sendReactionMessage({
        ...auth,
        to: args.to,
        targetMessageId: args.targetMessageId,
        emoji: args.emoji,
      });
    },
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp/provider/meta.test.ts`

Expected: PASS, 10 testes.

Se o teste `forwards credentials and args` falhar por causa de uma propriedade extra (`contextMessageId: undefined` vs ausente), ajuste a **asserção** para `expect.objectContaining({...})` — não mude a implementação. Repassar `undefined` explicitamente é o comportamento atual de `send-message.ts` e tem que ser preservado.

Se as assinaturas reais de `sendTemplateMessage` / `sendReactionMessage` em `src/lib/whatsapp/meta-api.ts:376` e `:680` divergirem dos campos acima, **a assinatura real vence** — ajuste `types.ts` e este arquivo, e anote a divergência no commit.

- [ ] **Step 5: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/lib/whatsapp/provider/meta.ts src/lib/whatsapp/provider/meta.test.ts
git commit -m "feat(provider): add the Meta implementation"
```

---

### Task 5: `sendWithAddressRetry` — o loop copiado quatro vezes

**Files:**
- Create: `src/lib/whatsapp/provider/retry.ts`
- Test: `src/lib/whatsapp/provider/retry.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Crie `src/lib/whatsapp/provider/retry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { sendWithAddressRetry } from './retry';
import type { WhatsAppProvider } from './types';

/** Provedor de mentira com política de endereço controlável. */
function fakeProvider(
  variants: string[],
  retryable: (e: unknown) => boolean
): WhatsAppProvider {
  return {
    kind: 'meta',
    addressVariants: () => variants,
    isRetryableAddressError: retryable,
  } as unknown as WhatsAppProvider;
}

describe('sendWithAddressRetry', () => {
  it('returns on the first address that succeeds', async () => {
    const attempt = vi.fn(async () => 'wamid.OK');
    const result = await sendWithAddressRetry(
      fakeProvider(['A', 'B'], () => true),
      'A',
      attempt
    );

    expect(result).toEqual({ messageId: 'wamid.OK', workingAddress: 'A' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('advances to the next address on a retryable error', async () => {
    const attempt = vi.fn(async (addr: string) => {
      if (addr === 'A') throw new Error('(#131030) not in allowed list');
      return 'wamid.OK';
    });

    const result = await sendWithAddressRetry(
      fakeProvider(['A', 'B'], (e) => String(e).includes('131030')),
      'A',
      attempt
    );

    expect(result).toEqual({ messageId: 'wamid.OK', workingAddress: 'B' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  // Erro não-retryable tem que subir IMEDIATAMENTE. Um "invalid token"
  // repetido em três variantes são três chamadas inúteis e três chances
  // de rate limit.
  it('rethrows a non-retryable error without trying the next address', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('invalid access token');
    });

    await expect(
      sendWithAddressRetry(fakeProvider(['A', 'B'], () => false), 'A', attempt)
    ).rejects.toThrow('invalid access token');

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('throws the last error when every address is exhausted', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('(#131030) not in allowed list');
    });

    await expect(
      sendWithAddressRetry(fakeProvider(['A', 'B'], () => true), 'A', attempt)
    ).rejects.toThrow('131030');

    expect(attempt).toHaveBeenCalledTimes(2);
  });

  // Um provedor sem variantes (Evolution) não pode virar zero tentativas.
  it('falls back to the given address when the provider yields no variants', async () => {
    const attempt = vi.fn(async () => 'wamid.OK');
    const result = await sendWithAddressRetry(
      fakeProvider([], () => false),
      'A',
      attempt
    );

    expect(result).toEqual({ messageId: 'wamid.OK', workingAddress: 'A' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/provider/retry.test.ts`

Expected: FAIL com `Failed to resolve import "./retry"`.

- [ ] **Step 3: Escrever a implementação**

Crie `src/lib/whatsapp/provider/retry.ts`:

```ts
// ============================================================
// O loop de retry por variante de endereço, extraído dos quatro
// lugares onde estava copiado (send-message.ts, flows/meta-send.ts ×2,
// automations/meta-send.ts).
//
// A política é do PROVEDOR: quais endereços tentar e o que conta como
// "tente o próximo". Este helper só executa. Assim a Evolution entra
// devolvendo uma variante só e nunca herda as tentativas de trunk-0
// que existem por causa do sandbox da Meta.
// ============================================================

import type { WhatsAppProvider } from './types';

export interface AddressRetryResult {
  messageId: string;
  /**
   * O endereço que efetivamente funcionou. Quando difere do que entrou,
   * o chamador grava de volta em `contacts.phone` — comportamento
   * preservado do código original.
   */
  workingAddress: string;
}

export async function sendWithAddressRetry(
  provider: WhatsAppProvider,
  address: string,
  attempt: (address: string) => Promise<string>
): Promise<AddressRetryResult> {
  // Um provedor que não conhece variantes ainda precisa de uma tentativa.
  const variants = provider.addressVariants(address);
  const candidates = variants.length > 0 ? variants : [address];

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const messageId = await attempt(candidate);
      return { messageId, workingAddress: candidate };
    } catch (err) {
      // Não-retryable sobe na hora: repetir "token inválido" em três
      // variantes é só três chamadas perdidas. O erro vai CRU para o
      // provedor — cada um stringifica (ou não) do jeito que precisar.
      if (!provider.isRetryableAddressError(err)) throw err;
      lastError = err;
      console.warn(
        `[provider:${provider.kind}] address "${candidate}" rejected, trying next…`
      );
    }
  }

  throw lastError;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp/provider/retry.test.ts`

Expected: PASS, 5 testes.

- [ ] **Step 5: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/lib/whatsapp/provider/retry.ts src/lib/whatsapp/provider/retry.test.ts
git commit -m "feat(provider): extract the address-variant retry loop"
```

---

### Task 6: `resolveProvider` — config → provedor pronto

**Files:**
- Create: `src/lib/whatsapp/provider/resolve.ts`
- Test: `src/lib/whatsapp/provider/resolve.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Crie `src/lib/whatsapp/provider/resolve.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  isLegacyFormat: vi.fn(() => false),
}));

import { resolveProvider, ProviderResolutionError } from './resolve';

/** Supabase de mentira que devolve uma linha de whatsapp_config. */
function dbReturning(row: unknown, error: unknown = null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: row, error }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const META_ROW = {
  id: 'cfg-1',
  account_id: 'acct-1',
  provider: 'meta',
  phone_number_id: 'pn-1',
  access_token: 'cipher',
  status: 'connected',
};

describe('resolveProvider', () => {
  it('builds a Meta provider from a meta row and decrypts the token', async () => {
    const { provider, config } = await resolveProvider(
      dbReturning(META_ROW),
      'acct-1'
    );

    expect(provider.kind).toBe('meta');
    expect(config.id).toBe('cfg-1');
  });

  // Linhas anteriores à migração 040 não têm `provider`. Tratar
  // undefined como 'meta' é o que mantém o comportamento idêntico numa
  // base que ainda não rodou a migração.
  it('treats a row with no provider column as meta', async () => {
    const legacy = { ...META_ROW, provider: undefined };
    const { provider } = await resolveProvider(dbReturning(legacy), 'acct-1');

    expect(provider.kind).toBe('meta');
  });

  it('throws whatsapp_not_configured when no row exists', async () => {
    await expect(
      resolveProvider(dbReturning(null), 'acct-1')
    ).rejects.toBeInstanceOf(ProviderResolutionError);
  });

  it('throws when a meta row has no phone_number_id', async () => {
    const broken = { ...META_ROW, phone_number_id: null };
    await expect(
      resolveProvider(dbReturning(broken), 'acct-1')
    ).rejects.toThrow(/phone_number_id/);
  });

  // A Evolution ainda não tem transporte; falhar alto é melhor do que
  // devolver um provedor Meta com credencial de Evolution, que mandaria
  // a chave da Evolution para graph.facebook.com.
  it('throws a clear not-implemented error for an evolution row', async () => {
    const evo = {
      id: 'cfg-2',
      account_id: 'acct-1',
      provider: 'evolution',
      phone_number_id: null,
      evolution_url: 'https://evo.example.com',
      evolution_instance: 'inst-1',
      access_token: 'cipher',
      status: 'connected',
    };

    await expect(resolveProvider(dbReturning(evo), 'acct-1')).rejects.toThrow(
      /not implemented/i
    );
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/provider/resolve.test.ts`

Expected: FAIL com `Failed to resolve import "./resolve"`.

- [ ] **Step 3: Escrever a implementação**

Crie `src/lib/whatsapp/provider/resolve.ts`:

```ts
// ============================================================
// Ponto único onde `whatsapp_config` vira um provedor utilizável.
//
// Antes desta função, os quatro caminhos de envio faziam cada um o seu
// SELECT + decrypt e carregavam a linha crua até a chamada de rede.
// Isso é o que tornava "adicionar um provedor" uma mudança em cinco
// lugares em vez de um.
//
// A linha crua continua sendo devolvida junto porque os chamadores
// precisam de `config.id` (auto-upgrade de ciphertext CBC legado) e de
// `config.mirror_inbound_media`. O que eles NÃO precisam mais é de
// `phone_number_id` e `access_token` — esses agora ficam presos dentro
// do provedor.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { metaProvider } from './meta';
import type { WhatsAppProvider } from './types';

export class ProviderResolutionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ProviderResolutionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * A linha crua de `whatsapp_config`, como o Supabase devolve — o shape
 * PRÉ-validação, com tudo opcional porque nada foi conferido ainda.
 * Depois que `resolveProvider`/`assertMetaConfig` validam, a mesma
 * linha satisfaz `WhatsAppConfigMeta`/`WhatsAppConfigEvolution` de
 * `@/types`. Os dois tipos descrevem a MESMA tabela em momentos
 * diferentes; a união é a canônica, este é o formato de fio.
 */
export interface RawConfigRow {
  id: string;
  account_id: string;
  provider?: string | null;
  phone_number_id?: string | null;
  access_token: string;
  evolution_url?: string | null;
  evolution_instance?: string | null;
  mirror_inbound_media?: boolean | null;
  [key: string]: unknown;
}

export interface ResolvedProvider {
  provider: WhatsAppProvider;
  config: RawConfigRow;
  /** Credencial descriptografada. Exposta só para o auto-upgrade de
   *  ciphertext legado no chamador; não use para montar requisições. */
  decryptedToken: string;
}

export async function resolveProvider(
  db: SupabaseClient,
  accountId: string
): Promise<ResolvedProvider> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (error || !config) {
    throw new ProviderResolutionError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const row = config as RawConfigRow;
  const decryptedToken = decrypt(row.access_token);

  // Linhas gravadas antes da migração 040 não têm `provider`. Toda
  // linha pré-040 é Meta por construção, então o default preserva o
  // comportamento numa base ainda não migrada.
  const kind = row.provider ?? 'meta';

  if (kind === 'evolution') {
    throw new ProviderResolutionError(
      'provider_not_implemented',
      'Evolution provider is not implemented yet.',
      501
    );
  }

  if (!row.phone_number_id) {
    throw new ProviderResolutionError(
      'whatsapp_not_configured',
      'WhatsApp config is missing phone_number_id.',
      400
    );
  }

  return {
    provider: metaProvider({
      phoneNumberId: row.phone_number_id,
      accessToken: decryptedToken,
    }),
    config: row,
    decryptedToken,
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp/provider/resolve.test.ts`

Expected: PASS, 5 testes.

- [ ] **Step 5: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/lib/whatsapp/provider/resolve.ts src/lib/whatsapp/provider/resolve.test.ts
git commit -m "feat(provider): add resolveProvider"
```

---

### Task 7: Migrar `send-message.ts`

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts:254-448`

A partir daqui **nenhum teste novo é escrito**. Os testes existentes são a rede de segurança: se algum mudar de resultado, o refactor errou.

- [ ] **Step 1: Rodar os testes do arquivo ANTES de tocar nele**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`

Expected: PASS. Anote o número de testes — tem que ser o mesmo no Step 4.

- [ ] **Step 2: Trocar o carregamento de config**

Substitua o bloco das linhas 254-285 (do comentário `// WhatsApp config, account-scoped.` até o fim do `if (isLegacyFormat(...)) { ... }`) por:

```ts
  // WhatsApp config + provedor, account-scoped.
  let resolved;
  try {
    resolved = await resolveProvider(db, accountId);
  } catch (err) {
    if (err instanceof ProviderResolutionError) {
      throw new SendMessageError(err.code, err.message, err.status);
    }
    throw err;
  }
  const { provider, config, decryptedToken } = resolved;

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(decryptedToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }
```

Atualize os imports no topo do arquivo: remova `decrypt` do import de `@/lib/whatsapp/encryption` (mantenha `encrypt` e `isLegacyFormat`), remova `phoneVariants` e `isRecipientNotAllowedError` do import de `phone-utils` (mantenha `sanitizePhoneForMeta` e `isValidE164`), remova o import inteiro de `@/lib/whatsapp/meta-api` **exceto** `type MediaKind`, e acrescente:

```ts
import { resolveProvider, ProviderResolutionError } from '@/lib/whatsapp/provider/resolve';
import { sendWithAddressRetry } from '@/lib/whatsapp/provider/retry';
```

- [ ] **Step 3: Trocar `attempt` para usar o provedor**

Substitua o corpo de `const attempt = async (phone: string): Promise<string> => { ... }` (linhas 339-403) por:

```ts
  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await provider.sendTemplate({
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await provider.sendMedia({
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await provider.sendInteractiveButtons({
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await provider.sendInteractiveList({
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await provider.sendText({
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };
```

E substitua o bloco de retry (linhas 405-438, do comentário `// Send via Meta — retry across phone-number variants` até o `catch` que lança `meta_error`) por:

```ts
  // Envia pelo provedor — retry entre variantes de endereço conforme a
  // política DELE; persiste a variante que funcionou de volta no
  // contato para o próximo envio ir direto.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const outcome = await sendWithAddressRetry(
      provider,
      sanitizedPhone,
      attempt
    );
    waMessageId = outcome.messageId;
    workingPhone = outcome.workingAddress;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown provider API error';
    console.error('[send-message] send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }
```

O código de erro segue `meta_error` e o texto segue `Meta API error:` **de propósito** — a API pública v1 documenta essa string e os testes a verificam. Renomear é mudança de contrato e não pertence a este plano.

- [ ] **Step 4: Rodar e confirmar que continua passando**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`

Expected: PASS, o mesmo número de testes do Step 1.

- [ ] **Step 5: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/lib/whatsapp/send-message.ts
git commit -m "refactor(send): route sendMessageToConversation through the provider seam"
```

---

### Task 8: Migrar `flows/meta-send.ts`

**Files:**
- Modify: `src/lib/flows/meta-send.ts` (as três funções)

- [ ] **Step 1: Rodar a suíte de flows ANTES**

Run: `npx vitest run src/lib/flows/`

Expected: PASS. Anote a contagem.

- [ ] **Step 2: Trocar imports**

No topo de `src/lib/flows/meta-send.ts`, remova o import inteiro de `@/lib/whatsapp/meta-api` **exceto** os tipos, remova o import de `decrypt`, e remova `phoneVariants` + `isRecipientNotAllowedError`:

```ts
import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  sanitizePhoneForMeta,
  isValidE164,
} from '@/lib/whatsapp/phone-utils'
import { resolveProvider } from '@/lib/whatsapp/provider/resolve'
import { sendWithAddressRetry } from '@/lib/whatsapp/provider/retry'
import { supabaseAdmin } from './admin-client'
```

- [ ] **Step 3: Reescrever `engineSendText`**

Nas linhas 85-126 de `engineSendText`, substitua tudo do `const { data: config, error: configErr }` até o fim do write-back de `contacts.phone` por:

```ts
  const { provider } = await resolveProvider(db, args.accountId)

  const { messageId: waMessageId, workingAddress } = await sendWithAddressRetry(
    provider,
    sanitized,
    async (phone) => {
      const r = await provider.sendText({ to: phone, text: args.text })
      return r.messageId
    },
  )

  if (workingAddress !== sanitized) {
    await db.from('contacts').update({ phone: workingAddress }).eq('id', contact.id)
  }
```

`resolveProvider` lança `ProviderResolutionError` com a mensagem `WhatsApp not configured...`, enquanto o código antigo lançava `Error('WhatsApp not configured for this account')`. O motor de flows só loga a mensagem, então a diferença é cosmética — **mas** se algum teste em `src/lib/flows/` casar essa string exata, atualize o teste, não a implementação.

- [ ] **Step 4: Reescrever `engineSendMedia`**

Nas linhas 195-239, aplique a mesma substituição:

```ts
  const { provider } = await resolveProvider(db, args.accountId)

  const { messageId: waMessageId, workingAddress } = await sendWithAddressRetry(
    provider,
    sanitized,
    async (phone) => {
      const r = await provider.sendMedia({
        to: phone,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      })
      return r.messageId
    },
  )

  if (workingAddress !== sanitized) {
    await db.from('contacts').update({ phone: workingAddress }).eq('id', contact.id)
  }
```

- [ ] **Step 5: Reescrever `sendInteractiveViaMeta`**

Nas linhas 347-407, aplique:

```ts
  const { provider } = await resolveProvider(db, input.accountId)

  const { messageId: waMessageId, workingAddress } = await sendWithAddressRetry(
    provider,
    sanitized,
    async (phone) => {
      if (input.kind === 'buttons') {
        const r = await provider.sendInteractiveButtons({
          to: phone,
          bodyText: input.bodyText,
          buttons: input.buttons,
          headerText: input.headerText,
          footerText: input.footerText,
        })
        return r.messageId
      }
      const r = await provider.sendInteractiveList({
        to: phone,
        bodyText: input.bodyText,
        buttonLabel: input.buttonLabel,
        sections: input.sections,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    },
  )

  if (workingAddress !== sanitized) {
    await db.from('contacts').update({ phone: workingAddress }).eq('id', contact.id)
  }
```

Renomeie a função de `sendInteractiveViaMeta` para `sendInteractiveViaProvider` e atualize as duas chamadas em `engineSendInteractiveButtons` (linha 307) e `engineSendInteractiveList` (linha 317). É função privada do módulo — nada fora dele referencia o nome.

- [ ] **Step 6: Rodar e confirmar**

Run: `npx vitest run src/lib/flows/`

Expected: PASS, a mesma contagem do Step 1.

- [ ] **Step 7: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/lib/flows/meta-send.ts
git commit -m "refactor(flows): route engine sends through the provider seam"
```

---

### Task 9: Migrar `automations/meta-send.ts`

**Files:**
- Modify: `src/lib/automations/meta-send.ts:112-209`

- [ ] **Step 1: Rodar a suíte de automations ANTES**

Run: `npx vitest run src/lib/automations/`

Expected: PASS. Anote a contagem.

- [ ] **Step 2: Trocar imports**

No topo do arquivo, remova o import de `sendTextMessage, sendTemplateMessage`, o de `decrypt`, e `phoneVariants` + `isRecipientNotAllowedError`. O resultado:

```ts
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import {
  sanitizePhoneForMeta,
  isValidE164,
} from '@/lib/whatsapp/phone-utils'
import { resolveProvider } from '@/lib/whatsapp/provider/resolve'
import { sendWithAddressRetry } from '@/lib/whatsapp/provider/retry'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import { supabaseAdmin } from './admin-client'
```

- [ ] **Step 3: Reescrever o miolo de `sendViaMeta`**

Substitua as linhas 138-209 (de `const { data: config, error: configErr }` até o fim do write-back) por:

```ts
  const { provider } = await resolveProvider(db, input.accountId)

  // Local template row — read for the body we persist below, not for
  // the Meta payload (the wire shape is deliberately unchanged here).
  // A missing row is fine: the send still goes out, we just can't
  // reconstruct the text the customer saw.
  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  const { messageId: waMessageId, workingAddress } = await sendWithAddressRetry(
    provider,
    sanitized,
    async (phone) => {
      if (input.kind === 'template') {
        const r = await provider.sendTemplate({
          to: phone,
          templateName: input.templateName,
          language: input.language,
          params: input.params,
        })
        return r.messageId
      }
      const r = await provider.sendText({ to: phone, text: input.text })
      return r.messageId
    },
  )

  if (workingAddress !== sanitized) {
    await db.from('contacts').update({ phone: workingAddress }).eq('id', contact.id)
  }
```

O bloco `templateRow` **muda de posição** — ele estava depois do `decrypt` e agora vem depois do `resolveProvider`. A ordem relativa ao envio é preservada (continua antes), que é o que importa: `templateContentText(templateRow, ...)` mais abaixo depende dele.

Renomeie `sendViaMeta` para `sendViaProvider` e atualize as duas chamadas em `engineSendText` (linha 56) e `engineSendTemplate` (linha 62).

- [ ] **Step 4: Rodar e confirmar**

Run: `npx vitest run src/lib/automations/`

Expected: PASS, a mesma contagem do Step 1.

- [ ] **Step 5: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/lib/automations/meta-send.ts
git commit -m "refactor(automations): route engine sends through the provider seam"
```

---

### Task 10: Migrar `broadcast-core.ts`

**Files:**
- Modify: `src/lib/whatsapp/broadcast-core.ts`

- [ ] **Step 1: Rodar a suíte de broadcast ANTES**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts src/lib/whatsapp/broadcast-resume.test.ts`

Expected: PASS. Anote a contagem.

- [ ] **Step 2: Trocar `BroadcastPlan` para carregar o provedor**

O plano hoje carrega as credenciais cruas (`broadcast-core.ts:69-70`). Substitua os dois campos por um provedor já montado:

```ts
export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  /** Provedor já vinculado às credenciais da conta. Substitui os
   *  antigos `phoneNumberId` + `accessToken`: o plano é construído uma
   *  vez e reusado em N destinatários, então resolver aqui mantém o
   *  único SELECT + decrypt que o código sempre teve. */
  provider: WhatsAppProvider;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}
```

Imports no topo: remova `sendTemplateMessage` de `meta-api`, remova `decrypt`, remova `phoneVariants` e `isRecipientNotAllowedError` de `phone-utils`; acrescente:

```ts
import { resolveProvider, ProviderResolutionError } from '@/lib/whatsapp/provider/resolve';
import type { WhatsAppProvider } from '@/lib/whatsapp/provider/types';
```

- [ ] **Step 3: Trocar o carregamento de config em `planBroadcast`**

Substitua o bloco das linhas 112-125 (do comentário `// Config (fail fast ...)` até `const accessToken = decrypt(config.access_token);`) por:

```ts
  // Provedor (fail fast + provides the audit trail owner already
  // resolved by the caller). Resolvido UMA vez para o plano inteiro.
  let provider: WhatsAppProvider;
  try {
    ({ provider } = await resolveProvider(db, accountId));
  } catch (err) {
    if (err instanceof ProviderResolutionError) {
      throw new BroadcastError(err.code, err.message, err.status);
    }
    throw err;
  }
```

E no objeto de retorno (linhas ~234-241), troque `phoneNumberId: config.phone_number_id,` e `accessToken,` por `provider,`.

`ProviderResolutionError` carrega `code = 'whatsapp_not_configured'`, `status = 400` e a mesma mensagem que o `BroadcastError` original lançava — a resposta HTTP fica byte a byte igual.

- [ ] **Step 4: Trocar as funções de política no loop de `deliverBroadcast`**

**Não substitua o loop por `sendWithAddressRetry`.** Este loop faz `break` em erro não-retryable e registra `lastError` por destinatário; o helper **lança**. Trocar abortaria o broadcast inteiro na primeira falha.

Mude só as duas chamadas de política e a de envio. Na linha 263:

```ts
    const variants = plan.provider.addressVariants(recipient.phone);
```

Na linha 269, dentro do `try`:

```ts
        const result = await plan.provider.sendTemplate({
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        });
```

E no `catch`, a guarda de retry — passe o erro **cru** (`error`), não a `message` já stringificada; a `message` continua sendo calculada para o `lastError` do destinatário:

```ts
        // Only a "recipient not allowed" error is worth another variant.
        if (!plan.provider.isRetryableAddressError(error)) break;
```

O `break` fica. A estrutura do loop fica. Só a origem da política muda.

- [ ] **Step 5: Atualizar `broadcast-resume.ts`**

Run: `grep -n "phoneNumberId\|accessToken\|BroadcastPlan" src/lib/whatsapp/broadcast-resume.ts`

Ele também monta um `BroadcastPlan`. Aplique a mesma troca: os dois campos de credencial viram `provider`, resolvido por `resolveProvider(db, accountId)` no mesmo ponto onde a config era carregada. Se o `grep` não retornar nada, o arquivo reusa `planBroadcast` e não precisa de mudança.

- [ ] **Step 6: Rodar e confirmar**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts src/lib/whatsapp/broadcast-resume.test.ts`

Expected: PASS, a mesma contagem do Step 1.

- [ ] **Step 7: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/lib/whatsapp/broadcast-core.ts src/lib/whatsapp/broadcast-resume.ts
git commit -m "refactor(broadcast): route delivery through the provider seam"
```

---

### Task 11: Migrar `api/whatsapp/broadcast/route.ts`

**Files:**
- Modify: `src/app/api/whatsapp/broadcast/route.ts:118-200`

Esta rota tem o **seu próprio** envio inline — não delega para `broadcast-core.ts`. É o caminho que a self-review deste plano quase deixou escapar.

- [ ] **Step 1: Rodar a suíte de rotas ANTES**

Run: `npx vitest run src/app/api/whatsapp/`

Expected: PASS. Anote a contagem.

- [ ] **Step 2: Trocar imports**

Remova `import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'` (linha 3) e `import { decrypt } from '@/lib/whatsapp/encryption'` (linha 4). Remova `phoneVariants` e `isRecipientNotAllowedError` do import de `phone-utils`. Acrescente:

```ts
import { resolveProvider, ProviderResolutionError } from '@/lib/whatsapp/provider/resolve'
```

- [ ] **Step 3: Trocar o carregamento de config**

Substitua as linhas 123-139 (do `const { data: config, error: configError }` até `const accessToken = decrypt(config.access_token)`) por:

```ts
    let provider
    try {
      ;({ provider } = await resolveProvider(supabase, accountId))
    } catch (err) {
      if (err instanceof ProviderResolutionError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
```

A mensagem de `ProviderResolutionError` para config ausente é exatamente `'WhatsApp not configured. Please set up your WhatsApp integration first.'` com status 400 — idêntica ao literal que estava embutido aqui.

- [ ] **Step 4: Trocar o loop de envio**

Mesma regra do Task 10: **o `break` fica, o loop fica**, só a política e o envio mudam. Na linha ~182:

```ts
      const variants = provider.addressVariants(sanitized)
```

Na linha ~188, dentro do `try`:

```ts
          const result = await provider.sendTemplate({
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
```

E a guarda no `catch` — erro **cru**, não a `message` (que segue existindo para o `lastError`):

```ts
          if (!provider.isRetryableAddressError(err)) break
```

(Confira o nome da variável do `catch` neste arquivo — se for `error`, use `error`.)

- [ ] **Step 5: Rodar e confirmar**

Run: `npx vitest run src/app/api/whatsapp/`

Expected: PASS, a mesma contagem do Step 1.

- [ ] **Step 6: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/app/api/whatsapp/broadcast/route.ts
git commit -m "refactor(broadcast-route): route inline sends through the provider seam"
```

---

### Task 12: Migrar `api/whatsapp/react/route.ts`

**Files:**
- Modify: `src/app/api/whatsapp/react/route.ts:91-112`

O caminho mais simples dos seis: sem retry, uma chamada só.

- [ ] **Step 1: Trocar imports**

Remova `import { sendReactionMessage } from '@/lib/whatsapp/meta-api';` (linha 3) e `import { decrypt } from '@/lib/whatsapp/encryption';` (linha 4). Acrescente:

```ts
import { resolveProvider, ProviderResolutionError } from '@/lib/whatsapp/provider/resolve';
```

- [ ] **Step 2: Trocar config + envio**

Substitua as linhas 91-105 (do `const { data: config, error: configError }` até `const accessToken = decrypt(config.access_token);`) por:

```ts
    // WhatsApp provider. Account-scoped post-multi-user.
    let provider;
    try {
      ({ provider } = await resolveProvider(supabase, accountId));
    } catch (err) {
      if (err instanceof ProviderResolutionError) {
        return NextResponse.json(
          { error: 'WhatsApp not configured.' },
          { status: 400 },
        );
      }
      throw err;
    }
```

A mensagem literal `'WhatsApp not configured.'` é preservada de propósito — esta rota sempre respondeu com um texto mais curto que as outras, e trocá-lo mudaria o que a UI mostra.

Em seguida, substitua a chamada de envio (linhas ~109-115) por:

```ts
      await provider.sendReaction({
        to: sanitizedPhone,
        targetMessageId: targetMessage.message_id,
        emoji,
      });
```

A linha `const sanitizedPhone = sanitizePhoneForMeta(contact.phone);` fica onde está.

- [ ] **Step 3: Rodar e confirmar**

Run: `npx vitest run src/app/api/whatsapp/`

Expected: PASS, a mesma contagem do Task 11.

- [ ] **Step 4: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add src/app/api/whatsapp/react/route.ts
git commit -m "refactor(react): route reaction sends through the provider seam"
```

---

### Task 13: Blindar as rotas Meta-only que continuam lendo `access_token`

**Files:**
- Modify: `src/lib/whatsapp/provider/resolve.ts` (acrescentar `assertMetaConfig`)
- Test: `src/lib/whatsapp/provider/resolve.test.ts` (acrescentar 2 casos)
- Modify: `src/app/api/whatsapp/config/route.ts:117`
- Modify: `src/app/api/whatsapp/config/verify-registration/route.ts:74`
- Modify: `src/app/api/whatsapp/media/[mediaId]/route.ts:65`
- Modify: `src/app/api/whatsapp/templates/submit/route.ts:165`
- Modify: `src/app/api/whatsapp/templates/sync/route.ts:164`
- Modify: `src/app/api/whatsapp/templates/[id]/route.ts:152` e `:292`
- Modify: `src/app/api/whatsapp/webhook/route.ts:298`

**Por que esta task existe.** As Tasks 7-12 tiraram os caminhos de *envio* de cima de `access_token`. Sobram oito sites, todos operações que só a Meta tem: submeter/sincronizar/editar template, baixar mídia por media id, verificar registro do número, e o webhook da Meta. Nenhum deles vira provider-agnóstico — não há equivalente na Evolution. Mas todos descriptografam `access_token` e mandam para `graph.facebook.com`, então numa linha `provider = 'evolution'` eles vazariam a chave da Evolution para a Meta.

A correção não é abstraí-los. É fazê-los **recusar** uma config que não é Meta.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente a `src/lib/whatsapp/provider/resolve.test.ts`:

```ts
import { assertMetaConfig } from './resolve';

describe('assertMetaConfig', () => {
  it('returns the meta credentials for a meta row', () => {
    expect(assertMetaConfig(META_ROW)).toEqual({
      phoneNumberId: 'pn-1',
      accessToken: 'decrypted:cipher',
    });
  });

  // O ponto inteiro da task: nunca descriptografar a credencial de um
  // provedor e mandá-la para o outro.
  it('refuses an evolution row instead of handing back its key', () => {
    const evo = { ...META_ROW, provider: 'evolution', phone_number_id: null };
    expect(() => assertMetaConfig(evo)).toThrow(/meta/i);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/whatsapp/provider/resolve.test.ts`

Expected: FAIL com `assertMetaConfig is not a function` (ou erro de import).

- [ ] **Step 3: Implementar**

Acrescente ao fim de `src/lib/whatsapp/provider/resolve.ts`:

```ts
/**
 * Portão para as rotas que são Meta-only por natureza (templates,
 * proxy de mídia por media id, registro do número, webhook da Meta).
 *
 * Elas não têm equivalente na Evolution e não vão para trás da
 * interface de provedor — mas TODAS descriptografam `access_token`,
 * que desde a migração 040 pode conter a chave da Evolution. Sem este
 * portão, uma conta em modo Evolution manda a própria chave para
 * graph.facebook.com no primeiro clique em "Sync from Meta".
 *
 * Falha alto de propósito: uma rota Meta chamada numa conta Evolution
 * é um bug de UI (o botão não devia estar visível), e um erro claro é
 * melhor do que uma requisição autenticada com o segredo errado.
 */
export function assertMetaConfig(config: RawConfigRow): {
  phoneNumberId: string;
  accessToken: string;
} {
  const kind = config.provider ?? 'meta';
  if (kind !== 'meta') {
    throw new ProviderResolutionError(
      'provider_mismatch',
      `This operation requires the Meta provider; this account is on "${kind}".`,
      400
    );
  }
  if (!config.phone_number_id) {
    throw new ProviderResolutionError(
      'whatsapp_not_configured',
      'WhatsApp config is missing phone_number_id.',
      400
    );
  }
  return {
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
  };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/whatsapp/provider/resolve.test.ts`

Expected: PASS, 7 testes.

- [ ] **Step 5: Aplicar nos oito sites**

Em cada um, substitua o par `config.phone_number_id` + `decrypt(config.access_token)` pela chamada única. O padrão, usando `templates/sync/route.ts:164` como exemplo:

```ts
    // antes
    const accessToken = decrypt(config.access_token)

    // depois
    const { phoneNumberId, accessToken } = assertMetaConfig(config)
```

e trocar os usos de `config.phone_number_id` por `phoneNumberId` no restante do handler.

Import a acrescentar em cada arquivo:

```ts
import { assertMetaConfig } from '@/lib/whatsapp/provider/resolve'
```

O import de `decrypt` sai, **exceto** em `config/route.ts`, que também **grava** a credencial e continua precisando de `encrypt`.

Dois casos merecem atenção:

- **`webhook/route.ts:298`** roda dentro do handler de eventos, onde não há resposta HTTP para devolver. Envolva em `try/catch`, logue, e siga — o webhook nunca deve derrubar o processamento do lote:

  ```ts
      let decryptedAccessToken: string
      try {
        ({ accessToken: decryptedAccessToken } = assertMetaConfig(config))
      } catch (err) {
        console.error(
          '[webhook] skipping: config is not a Meta provider',
          err instanceof Error ? err.message : err
        )
        continue
      }
  ```

  Confirme que `continue` é válido no contexto (o site está dentro do `for` sobre `entry`). Se não for, use `return` da função de processamento.

- **`templates/[id]/route.ts`** tem **dois** sites (`:152` e `:292`), em handlers diferentes. Os dois precisam da guarda.

- [ ] **Step 6: Verificar que nenhum decrypt cru sobrou**

Run:
```bash
grep -rn "decrypt(config.access_token)\|decrypt(.*\.access_token" src/ --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -v "provider/resolve.ts"
```

Expected: **nenhuma saída.** Único lugar que descriptografa `access_token` passa a ser `provider/resolve.ts`, nas duas funções.

- [ ] **Step 7: Commit**

```bash
npx prettier --write <arquivos desta task>   # NUNCA 'npm run format' (repo inteiro)
git add -A
git commit -m "fix(provider): refuse Meta-only routes on a non-Meta config"
```

---

### Task 14: Verificação final

**Files:** nenhum — este é o portão.

- [ ] **Step 1: Suíte completa**

Run: `npm run test`

Expected: **exatamente** `Test Files 2 failed | 77 passed`, `Tests 5 failed | 824 passed (829)`. As 5 falhas têm que ser as mesmas de `currency.test.ts` e `date-utils.test.ts` do baseline. **Qualquer falha nova reprova a task** — volte ao commit da task correspondente e compare o comportamento.

Se a contagem total de testes subiu de 829, é porque as Tasks 4-6 adicionaram 20 (10+5+5) e a Task 13 mais 2: o esperado passa a ser `851`, com as mesmas 5 falhas.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: zero erros. Se sobrar erro em `src/components/settings/whatsapp-config.tsx` por causa da união discriminada da Task 2, estreite com `config.provider === 'meta'` antes de acessar `phone_number_id` — não use `as any`.

- [ ] **Step 3: Lint e build**

Run: `npm run lint`

Expected: zero erros.

Run: `npm run build`

Expected: build completo sem erro.

- [ ] **Step 4: Confirmar que nenhum caminho de envio fala com a Meta diretamente**

Run:
```bash
grep -rn "decrypt(config.access_token)\|phoneNumberId:" src/lib/whatsapp/send-message.ts src/lib/flows/meta-send.ts src/lib/automations/meta-send.ts src/lib/whatsapp/broadcast-core.ts src/lib/whatsapp/broadcast-resume.ts src/app/api/whatsapp/broadcast/route.ts src/app/api/whatsapp/react/route.ts
```

Expected: **nenhuma saída.** Qualquer ocorrência é um caminho que ainda monta credencial Meta por conta própria.

Run:
```bash
grep -rn "^import {" src/lib/whatsapp/send-message.ts src/lib/flows/meta-send.ts src/lib/automations/meta-send.ts src/lib/whatsapp/broadcast-core.ts src/app/api/whatsapp/broadcast/route.ts src/app/api/whatsapp/react/route.ts -A2 | grep "meta-api"
```

Expected: nenhuma saída, ou só linhas precedidas de `import type`. Um `import {` (valor, não tipo) de `meta-api` num desses seis arquivos significa que a migração daquele arquivo ficou pela metade.

- [ ] **Step 5: Confirmar que o seam é o único caminho**

Run:
```bash
grep -rln "sendTextMessage\|sendTemplateMessage\|sendMediaMessage\|sendInteractiveButtons\|sendInteractiveList\|sendReactionMessage" src/ --include=*.ts --include=*.tsx | grep -v ".test." | grep -v "provider/" | grep -v "meta-api.ts"
```

Expected: **nenhuma saída.** Depois deste plano, `src/lib/whatsapp/provider/meta.ts` deve ser o único não-teste que chama as funções de envio de `meta-api.ts`. Se aparecer algum arquivo, é um sétimo caminho de envio que nem este plano nem a análise mapearam — **pare e reporte** antes de seguir para o plano 2.

- [ ] **Step 6: Commit final**

```bash
git add -A
git commit -m "chore: verify provider seam refactor leaves behaviour unchanged"
```

---

## O que este plano deliberadamente NÃO faz

Registrado aqui para que ninguém "complete" o refactor por conta própria:

- **Não implementa a Evolution.** `resolveProvider` lança `501 not implemented` numa linha `provider = 'evolution'`. É plano 2.
- **Não toca no webhook inbound.** `src/app/api/whatsapp/webhook/route.ts` continua 100% Meta. É plano 2.
- **Não toca em UI.** Nenhum seletor de provedor, nenhum QR. É plano 3.
- **Não conserta as 5 falhas de locale/fuso.** Trabalho separado, não relacionado.
- **Não unifica a persistência.** Os quatro caminhos continuam com o próprio `INSERT` em `messages`. Tentador, mas é outro refactor com outro risco — e o seam de transporte já entrega o que a Evolution precisa.
- **Não mexe em `sanitizePhoneForMeta` nem no write-back de `contacts.phone`.** A conversão E.164 ↔ JID e o risco de sobrescrever o telefone real do contato entram no plano 2, junto com o provedor que realmente precisa disso.
- **Não adiciona `checkConnection()` à interface.** Ele pertence a ela, mas na Meta não há estado de sessão análogo — o mais próximo é `registered_at` / `subscribed_apps_at`, semântica diferente. Implementar agora seria inventar um retorno para um método sem consumidor. Entra no plano 2, junto com o healthcheck periódico que o consome.

## Decisões de layout herdadas para o plano 2

Registradas aqui porque foram tomadas junto com este plano:

- **Rotas de gerenciamento em `/api/whatsapp/evolution/*`, não `/api/evolution/*`.** O prefixo importa: [`src/middleware.ts:80-82`](../../../src/middleware.ts) já barra requisição sem sessão em `/api/whatsapp/*`, exceto paths contendo `/webhook`. Pendurar o gerenciamento sob `/api/whatsapp/` herda essa checagem de graça; um namespace novo sobe aberto. **Isto não dispensa a checagem de papel admin no handler** — o middleware só distingue autenticado de anônimo, e qualquer `viewer` da conta passa por ele.
- **O webhook fica em `/api/evolution/webhook`** — fora do gate, que é o correto para um endpoint chamado por servidor externo, e por isso carrega sua própria autenticação por segredo.
- **A rota de save (`config/route.ts`) grava `baseRow` sem `provider`.** Correto no plano 1: o DEFAULT 'meta' cobre o INSERT e nada consegue criar linha Evolution ainda. Mas no dia em que o seletor de provedor existir, a troca Meta↔Evolution TEM que limpar as colunas de identidade do provedor anterior no mesmo UPDATE — o `whatsapp_config_provider_fields_check` simétrico da 040 recusa a linha híbrida. O save de provedor é um UPDATE que define o conjunto novo e anula o antigo, atomicamente.
