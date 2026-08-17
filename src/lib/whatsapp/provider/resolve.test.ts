import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  isLegacyFormat: vi.fn(() => false),
}));

import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveProvider, ProviderResolutionError } from './resolve';

/**
 * Supabase de mentira que devolve uma linha de whatsapp_config — e
 * GRAVA o que foi consultado. A tabela e o filtro de tenancy são o que
 * esta função tem de mais importante; sem registrá-los, apagar o
 * `.eq('account_id', …)` deixaria a suíte verde enquanto sete caminhos
 * de envio leem a config de outro tenant.
 */
function dbReturning(row: unknown, error: unknown = null) {
  const seen: { table?: string; filters: [string, unknown][] } = {
    filters: [],
  };
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      seen.filters.push([col, val]);
      return chain;
    },
    single: async () => ({ data: row, error }),
  };
  const db = {
    from: (table: string) => {
      seen.table = table;
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, seen };
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
    const { db, seen } = dbReturning(META_ROW);
    const { provider, config } = await resolveProvider(db, 'acct-1');

    expect(provider.kind).toBe('meta');
    expect(config.id).toBe('cfg-1');
    // Tenancy: a ÚNICA coisa que este módulo não pode errar. Sem esta
    // asserção, remover o filtro de account_id deixaria a suíte verde.
    expect(seen.table).toBe('whatsapp_config');
    expect(seen.filters).toContainEqual(['account_id', 'acct-1']);
  });

  // Linhas anteriores à migração 040 não têm `provider`. Tratar
  // undefined como 'meta' é o que mantém o comportamento idêntico numa
  // base que ainda não rodou a migração.
  it('treats a row with no provider column as meta', async () => {
    const legacy = { ...META_ROW, provider: undefined };
    const { provider } = await resolveProvider(
      dbReturning(legacy).db,
      'acct-1'
    );

    expect(provider.kind).toBe('meta');
  });

  it('throws whatsapp_not_configured when no row exists', async () => {
    await expect(
      resolveProvider(dbReturning(null).db, 'acct-1')
    ).rejects.toBeInstanceOf(ProviderResolutionError);
  });

  it('throws when a meta row has no phone_number_id', async () => {
    const broken = { ...META_ROW, phone_number_id: null };
    await expect(
      resolveProvider(dbReturning(broken).db, 'acct-1')
    ).rejects.toThrow(/phone_number_id/);
  });

  // A Evolution ainda não tem transporte; falhar alto é melhor do que
  // devolver um provedor Meta com credencial de Evolution, que mandaria
  // a chave da Evolution para graph.facebook.com. E a recusa acontece
  // ANTES do decrypt: o segredo não sai da coluna para ser descartado.
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

    await expect(
      resolveProvider(dbReturning(evo).db, 'acct-1')
    ).rejects.toThrow(/not implemented/i);
    expect(decrypt).not.toHaveBeenCalled();
  });

  // Fail-closed: um valor de provider desconhecido (base sem o CHECK da
  // 040, terceiro provedor futuro sem transporte) NÃO pode cair no ramo
  // Meta e mandar a credencial para graph.facebook.com.
  it('refuses an unknown provider value instead of defaulting to meta', async () => {
    const weird = { ...META_ROW, provider: 'evolutoin' };
    await expect(
      resolveProvider(dbReturning(weird).db, 'acct-1')
    ).rejects.toThrow(/not implemented/i);
    expect(decrypt).not.toHaveBeenCalled();
  });
});
