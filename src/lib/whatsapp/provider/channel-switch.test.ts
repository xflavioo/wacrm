import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// O desvio por canal: conta `meta` continua falando com meta-api;
// conta `evolution` fala com o cliente novo. Nada dos dois cruza.
const h = vi.hoisted(() => ({
  metaSendText: vi.fn(),
  evoSendText: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: h.metaSendText,
}));
vi.mock('@/lib/whatsapp/evolution/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/evolution/client')>()),
  sendText: h.evoSendText,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    // Fila antibanimento: slot imediato.
    rpc: async () => ({ data: new Date(0).toISOString(), error: null }),
  }),
}));

import { resolveProvider } from './resolve';
import { sendWithAddressRetry } from './retry';

function dbWith(row: unknown) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const META_ROW = {
  id: 'c1',
  account_id: 'acc-1',
  provider: 'meta',
  phone_number_id: 'PN1',
  access_token: 'meta-cipher',
};
const EVO_ROW = {
  id: 'c2',
  account_id: 'acc-2',
  provider: 'evolution',
  phone_number_id: null,
  evolution_url: 'https://evo.example.com',
  evolution_instance: 'niver',
  access_token: 'evo-cipher',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.metaSendText.mockResolvedValue({ messageId: 'wamid.META' });
  h.evoSendText.mockResolvedValue({ messageId: 'EVO-KEY' });
});

describe('channel switch', () => {
  it('a meta account keeps calling meta-api (with its own token) and never the Evolution client', async () => {
    const { provider } = await resolveProvider(dbWith(META_ROW), 'acc-1');
    const out = await sendWithAddressRetry(provider, '5591988887777', async (to) =>
      (await provider.sendText({ to, text: 'oi' })).messageId
    );

    expect(out.messageId).toBe('wamid.META');
    expect(h.metaSendText).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'PN1', accessToken: 'plain:meta-cipher', to: '5591988887777', text: 'oi' })
    );
    expect(h.evoSendText).not.toHaveBeenCalled();
  });

  it('an evolution account calls the Evolution client (with its API key) and never meta-api', async () => {
    const { provider } = await resolveProvider(dbWith(EVO_ROW), 'acc-2');
    const out = await sendWithAddressRetry(provider, '5591988887777', async (to) =>
      (await provider.sendText({ to, text: 'oi' })).messageId
    );

    expect(out).toEqual({ messageId: 'EVO-KEY', workingAddress: '5591988887777' });
    expect(h.evoSendText).toHaveBeenCalledWith(
      { baseUrl: 'https://evo.example.com', instance: 'niver', apiKey: 'plain:evo-cipher' },
      expect.objectContaining({ number: '5591988887777', text: 'oi' })
    );
    expect(h.metaSendText).not.toHaveBeenCalled();
  });

  it('the Evolution key is never sent to the Meta client, nor the Meta token to Evolution', async () => {
    const meta = await resolveProvider(dbWith(META_ROW), 'acc-1');
    await meta.provider.sendText({ to: '1', text: 'x' });
    const evo = await resolveProvider(dbWith(EVO_ROW), 'acc-2');
    await evo.provider.sendText({ to: '1', text: 'x' });

    expect(JSON.stringify(h.metaSendText.mock.calls)).not.toContain('evo-cipher');
    expect(JSON.stringify(h.evoSendText.mock.calls)).not.toContain('meta-cipher');
  });
});
