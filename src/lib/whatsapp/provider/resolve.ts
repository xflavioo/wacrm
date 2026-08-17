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

  // Linhas gravadas antes da migração 040 não têm `provider`. Toda
  // linha pré-040 é Meta por construção, então o default preserva o
  // comportamento numa base ainda não migrada.
  const kind = row.provider ?? 'meta';

  // Decidir o provedor ANTES de descriptografar: o segredo só sai da
  // coluna quando já se sabe para quem ele é. Mesma disciplina do
  // `assertMetaConfig` (Task 13).
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
