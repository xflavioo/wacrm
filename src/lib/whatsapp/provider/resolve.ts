// ============================================================
// Ponto único onde `whatsapp_config` vira um provedor utilizável.
//
// Antes desta função, cada caminho de envio fazia o seu próprio
// SELECT + decrypt e carregava a linha crua até a chamada de rede —
// nove sites em sete arquivos. Isso é o que tornava "adicionar um
// provedor" uma mudança espalhada em vez de uma.
//
// A linha crua continua sendo devolvida junto porque `send-message.ts`
// precisa de `config.id` + `config.access_token` para o auto-upgrade de
// ciphertext CBC legado. O que os chamadores NÃO precisam mais é de
// `phone_number_id` e do token em claro — esses ficam presos dentro do
// provedor.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  EvolutionConfigError,
  evolutionCredsFromRow,
  type EvolutionConfigRow,
} from '@/lib/whatsapp/evolution/config';
import { evolutionProvider } from '@/lib/whatsapp/evolution/provider';
import { dbThrottle } from '@/lib/whatsapp/evolution/throttle';
import { metaProvider, type MetaCredentials } from './meta';
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

  // Linhas gravadas antes da migração 040 não têm `provider`. Toda
  // linha pré-040 é Meta por construção, então o default preserva o
  // comportamento numa base ainda não migrada.
  const kind = row.provider ?? 'meta';

  // Decidir o provedor ANTES de descriptografar: o segredo só sai da
  // coluna quando já se sabe para quem ele é. Mesma disciplina do
  // `assertMetaConfig` (Task 13).
  //
  // Canal QR code: a credencial em `access_token` é a API key da
  // Evolution e só é descriptografada aqui, para o servidor Evolution.
  if (kind === 'evolution') {
    let creds;
    try {
      creds = evolutionCredsFromRow(row as unknown as EvolutionConfigRow);
    } catch (err) {
      if (err instanceof EvolutionConfigError) {
        throw new ProviderResolutionError(
          'whatsapp_not_configured',
          err.message,
          400
        );
      }
      throw err;
    }
    return {
      // A fila antibanimento usa o service role mesmo quando `db` é o
      // cliente do usuário (RLS): `claim_evolution_send_slot` só é
      // executável pelo service role, e o `account_id` é explícito.
      provider: evolutionProvider(creds, {
        throttle: dbThrottle(supabaseAdmin(), accountId),
      }),
      config: row,
      decryptedToken: creds.apiKey,
    };
  }

  // Fail-closed: `!== 'meta'`, não `=== 'evolution'`. Qualquer outro
  // valor — um terceiro provedor futuro, ou lixo numa base sem o CHECK
  // da 040 — tem que parar AQUI, e não cair no ramo Meta e mandar a
  // credencial errada para graph.facebook.com.
  if (kind !== 'meta') {
    throw new ProviderResolutionError(
      'provider_not_implemented',
      `Provider "${kind}" is not implemented yet.`,
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

  const decryptedToken = decrypt(row.access_token);

  return {
    provider: metaProvider({
      phoneNumberId: row.phone_number_id,
      accessToken: decryptedToken,
    }),
    config: row,
    decryptedToken,
  };
}

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
export function assertMetaConfig(config: RawConfigRow): MetaCredentials {
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
