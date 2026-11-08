// ============================================================
// Linha de `whatsapp_config` de uma conta Evolution → credenciais.
//
// Único lugar que descriptografa a API key. Fica separado de
// `provider/resolve.ts` para as rotas de gerenciamento e o webhook
// (que não passam por `resolveProvider`) usarem o mesmo caminho.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import type { EvolutionCreds } from './client';

/** Linha crua de uma conta Evolution (colunas das migrações 040 + 041). */
export interface EvolutionConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  provider: string | null;
  access_token: string;
  evolution_url: string | null;
  evolution_instance: string | null;
  evolution_webhook_secret_hash: string | null;
  evolution_phone: string | null;
  evolution_min_interval_ms: number | null;
  evolution_jitter_ms: number | null;
  evolution_broadcast_max: number | null;
  status: 'connected' | 'disconnected' | 'connecting';
  mirror_inbound_media?: boolean | null;
  [key: string]: unknown;
}

export class EvolutionConfigError extends Error {
  readonly code: 'not_evolution' | 'incomplete' | 'decrypt_failed';
  constructor(code: EvolutionConfigError['code'], message: string) {
    super(message);
    this.name = 'EvolutionConfigError';
    this.code = code;
  }
}

/**
 * Credenciais prontas para o cliente. Decide o provedor ANTES de
 * descriptografar (mesma disciplina de `assertMetaConfig`): numa linha
 * Meta, `access_token` é o token do Graph e nunca deve sair daqui.
 */
export function evolutionCredsFromRow(row: EvolutionConfigRow): EvolutionCreds {
  if ((row.provider ?? 'meta') !== 'evolution') {
    throw new EvolutionConfigError(
      'not_evolution',
      'Esta conta não está configurada para o canal Evolution (QR code).'
    );
  }
  if (!row.evolution_url || !row.evolution_instance) {
    throw new EvolutionConfigError(
      'incomplete',
      'A configuração do Evolution está incompleta (URL ou instância ausente).'
    );
  }
  let apiKey: string;
  try {
    apiKey = decrypt(row.access_token);
  } catch {
    throw new EvolutionConfigError(
      'decrypt_failed',
      'Não foi possível descriptografar a API key salva (a ENCRYPTION_KEY mudou?). Informe a chave novamente.'
    );
  }
  return {
    baseUrl: row.evolution_url,
    instance: row.evolution_instance,
    apiKey,
  };
}

/** Carrega a linha Evolution de uma conta (qualquer cliente; sempre filtrado por conta). */
export async function loadEvolutionRow(
  db: SupabaseClient,
  accountId: string
): Promise<EvolutionConfigRow | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .maybeSingle();
  if (error) {
    console.error('[evolution] failed to load config:', error.message);
    return null;
  }
  return (data as EvolutionConfigRow | null) ?? null;
}

/** Estado do Evolution → `whatsapp_config.status`. */
export function stateToStatus(
  state: 'open' | 'connecting' | 'close'
): 'connected' | 'connecting' | 'disconnected' {
  if (state === 'open') return 'connected';
  if (state === 'connecting') return 'connecting';
  return 'disconnected';
}
