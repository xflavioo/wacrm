import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dispatchInboundToAiReply: vi.fn(),
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
}));

vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.runAutomationsForTrigger }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatchWebhookEvent }));

import {
  persistAndDispatchInbound,
  persistOutboundFromPhone,
  type InboundThread,
  type NormalizedInboundMessage,
} from './inbound';

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

function fakeDb(upsertRows: unknown[]) {
  const calls: Call[] = [];
  const db = {
    rpc: (name: string, args: unknown) => {
      calls.push({ table: 'rpc', op: name, args: [args] });
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const res = () =>
        Promise.resolve({
          data: table === 'messages' ? upsertRows : null,
          count: 0,
          error: null,
        });
      for (const op of ['select', 'eq', 'in', 'order', 'limit', 'update', 'insert', 'upsert']) {
        chain[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return chain;
        };
      }
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.then = (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => res().then(a, b);
      return chain;
    },
  };
  return { db: db as never, calls };
}

const thread: InboundThread = {
  contact: { contact: { id: 'ct-1' }, wasCreated: false },
  conversation: { id: 'cv-1', status: 'open' },
  conversationCreated: false,
};

const msg: NormalizedInboundMessage = {
  providerMessageId: 'EVO1',
  rawType: 'text',
  contentType: 'text',
  contentText: 'Olá',
  mediaUrl: null,
  mediaType: null,
  interactiveReplyId: null,
  replyToProviderId: null,
  timestampSeconds: 1_780_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false });
  h.runAutomationsForTrigger.mockResolvedValue(undefined);
});

describe('persistOutboundFromPhone', () => {
  it('stores an agent message, refreshes the preview, and fires nothing else', async () => {
    const { db, calls } = fakeDb([{ id: 'new-row' }]);
    const ok = await persistOutboundFromPhone(
      { db, accountId: 'acc-1', configOwnerUserId: 'u-1' },
      thread,
      msg
    );
    expect(ok).toBe(true);

    const up = calls.find((c) => c.table === 'messages' && c.op === 'upsert')!;
    expect(up.args[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'agent',
      status: 'sent',
      message_id: 'EVO1',
    });
    expect(up.args[1]).toEqual({ onConflict: 'conversation_id,message_id', ignoreDuplicates: true });

    expect(calls.some((c) => c.op === 'bump_conversation_on_inbound')).toBe(false); // sem não lidas
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('is a no-op for a message that already exists (wacrm sent it)', async () => {
    const { db, calls } = fakeDb([]); // ON CONFLICT DO NOTHING → nenhuma linha
    const ok = await persistOutboundFromPhone(
      { db, accountId: 'acc-1', configOwnerUserId: 'u-1' },
      thread,
      msg
    );
    expect(ok).toBe(false);
    expect(calls.some((c) => c.table === 'conversations' && c.op === 'update')).toBe(false);
  });
});

describe('persistAndDispatchInbound (shared with the Meta webhook)', () => {
  it('on a genuine first insert: bumps unread, runs flows, automations, AI and the public webhook', async () => {
    const { db, calls } = fakeDb([{ id: 'new-row' }]);
    await persistAndDispatchInbound({ db, accountId: 'acc-1', configOwnerUserId: 'u-1' }, thread, msg);

    expect(calls.some((c) => c.op === 'bump_conversation_on_inbound')).toBe(true);
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1);
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1', conversationId: 'cv-1', contactId: 'ct-1' })
    );
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(db, 'acc-1', 'message.received', expect.anything());
  });

  it('replayed delivery (no row inserted): nothing downstream runs', async () => {
    const { db, calls } = fakeDb([]);
    await persistAndDispatchInbound({ db, accountId: 'acc-1', configOwnerUserId: 'u-1' }, thread, msg);

    expect(calls.some((c) => c.op === 'bump_conversation_on_inbound')).toBe(false);
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('a flow that consumed the message suppresses the AI reply', async () => {
    h.dispatchInboundToFlows.mockResolvedValue({ consumed: true });
    const { db } = fakeDb([{ id: 'new-row' }]);
    await persistAndDispatchInbound({ db, accountId: 'acc-1', configOwnerUserId: 'u-1' }, thread, msg);
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
  });
});
