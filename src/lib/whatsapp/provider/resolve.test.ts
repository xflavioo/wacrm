import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  isLegacyFormat: vi.fn(() => false),
}));

import { decrypt } from '@/lib/whatsapp/encryption';
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

    await expect(resolveProvider(dbReturning(evo), 'acct-1')).rejects.toThrow(
      /not implemented/i
    );
    expect(decrypt).not.toHaveBeenCalled();
  });
});
