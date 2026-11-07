import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  after: [] as (() => Promise<void> | void)[],
  processEvolutionEvent: vi.fn(),
  configRow: null as Record<string, unknown> | null,
  lookups: [] as { column: string; value: unknown }[],
}));

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.after.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          h.lookups.push({ column, value });
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: h.configRow, error: null }),
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/whatsapp/evolution/webhook-handler', () => ({
  processEvolutionEvent: h.processEvolutionEvent,
}));

import { POST } from './route';
import { generateWebhookSecret, hashWebhookSecret } from '@/lib/whatsapp/evolution/secret';

const secret = generateWebhookSecret();

function configFor(s: string) {
  return {
    id: 'cfg-1',
    account_id: 'acc-1',
    user_id: 'u-1',
    provider: 'evolution',
    evolution_instance: 'niver',
    evolution_webhook_secret_hash: hashWebhookSecret(s),
  };
}

function call(urlSecret: string, body: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`https://crm.example.com/api/evolution/webhook/${urlSecret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ secret: urlSecret }) }) as Promise<{
    body: unknown;
    status: number;
  }>;
}

const validEvent = { event: 'messages.upsert', instance: 'niver', data: { key: { id: 'A' } } };

beforeEach(() => {
  h.after.length = 0;
  h.lookups.length = 0;
  h.processEvolutionEvent.mockReset();
  h.configRow = null;
});

describe('POST /api/evolution/webhook/[secret]', () => {
  it('401 when the secret matches no account', async () => {
    h.configRow = null;
    const res = await call(generateWebhookSecret(), validEvent);
    expect(res.status).toBe(401);
    expect(h.after).toHaveLength(0);
  });

  it('401 when the stored hash differs from the presented one (constant-time re-check)', async () => {
    h.configRow = configFor(generateWebhookSecret()); // outra conta devolvida pelo banco
    const res = await call(secret, validEvent);
    expect(res.status).toBe(401);
    expect(h.processEvolutionEvent).not.toHaveBeenCalled();
  });

  it('401 for a malformed secret, without even querying the database', async () => {
    const res = await call('short', validEvent);
    expect(res.status).toBe(401);
    expect(h.lookups).toHaveLength(0);
  });

  it('looks the account up by the HASH of the secret, never the secret itself', async () => {
    h.configRow = configFor(secret);
    await call(secret, validEvent);
    const hashLookup = h.lookups.find((l) => l.column === 'evolution_webhook_secret_hash');
    expect(hashLookup?.value).toBe(hashWebhookSecret(secret));
    expect(h.lookups.some((l) => l.value === secret)).toBe(false);
  });

  it('200 with the right secret, processing happens after the response', async () => {
    h.configRow = configFor(secret);
    const res = await call(secret, validEvent);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received' });

    expect(h.processEvolutionEvent).not.toHaveBeenCalled(); // ainda não: é no after()
    expect(h.after).toHaveLength(1);
    await h.after[0]();
    expect(h.processEvolutionEvent).toHaveBeenCalledTimes(1);
    expect(h.processEvolutionEvent.mock.calls[0][1]).toMatchObject({ account_id: 'acc-1' });
    expect(h.processEvolutionEvent.mock.calls[0][2]).toMatchObject({ event: 'messages.upsert' });
  });

  it('400 on invalid JSON', async () => {
    h.configRow = configFor(secret);
    const res = await call(secret, '{not json');
    expect(res.status).toBe(400);
    expect(h.after).toHaveLength(0);
  });

  it('400 when the payload has no event (invalid envelope)', async () => {
    h.configRow = configFor(secret);
    const res = await call(secret, { data: {} });
    expect(res.status).toBe(400);
    expect(h.after).toHaveLength(0);
  });

  it('413 when the declared body is too large', async () => {
    h.configRow = configFor(secret);
    const res = await call(secret, validEvent, { 'content-length': String(5 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it('acks but does not process an event for a different instance', async () => {
    h.configRow = configFor(secret);
    const res = await call(secret, { ...validEvent, instance: 'outra-instancia' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored' });
    expect(h.after).toHaveLength(0);
  });
});
