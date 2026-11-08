import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveInboundThread: vi.fn(),
  persistAndDispatchInbound: vi.fn(),
  persistOutboundFromPhone: vi.fn(),
  applyInboundReaction: vi.fn(),
  applyStatusUpdate: vi.fn(),
  // Os disparadores que um `fromMe` NUNCA pode acionar.
  dispatchInboundToAiReply: vi.fn(),
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  getMediaBase64: vi.fn(),
  fetchConnectedNumber: vi.fn(),
  mirrorInboundMedia: vi.fn(),
}));

vi.mock('@/lib/whatsapp/inbound', () => ({
  resolveInboundThread: h.resolveInboundThread,
  persistAndDispatchInbound: h.persistAndDispatchInbound,
  persistOutboundFromPhone: h.persistOutboundFromPhone,
  applyInboundReaction: h.applyInboundReaction,
}));
vi.mock('@/lib/whatsapp/status-update', () => ({ applyStatusUpdate: h.applyStatusUpdate }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.runAutomationsForTrigger }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }));
vi.mock('@/lib/whatsapp/mirror-inbound-media', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/mirror-inbound-media')>()),
  mirrorInboundMedia: h.mirrorInboundMedia,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec(${s})`, encrypt: (s: string) => s }));
vi.mock('./client', async (orig) => ({
  ...(await orig<typeof import('./client')>()),
  getMediaBase64: h.getMediaBase64,
  fetchConnectedNumber: h.fetchConnectedNumber,
}));

import { processEvolutionEvent } from './webhook-handler';
import type { EvolutionConfigRow } from './config';

// --- um banco falso mínimo: cada tabela devolve o que o teste programar ---
interface Call {
  table: string;
  op: string;
  args: unknown[];
}

function fakeDb(results: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const calls: Call[] = [];
  const db = {
    storage: {},
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const result = () => Promise.resolve({ data: null, error: null, ...(results[table] ?? {}) });
      for (const op of [
        'select', 'eq', 'in', 'is', 'gte', 'order', 'limit', 'update', 'insert', 'upsert', 'delete',
      ]) {
        chain[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return chain;
        };
      }
      chain.maybeSingle = result;
      chain.single = result;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => result().then(res, rej);
      return chain;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, calls };
}

const row: EvolutionConfigRow = {
  id: 'cfg-1',
  account_id: 'acc-1',
  user_id: 'user-1',
  provider: 'evolution',
  access_token: 'enc-key',
  evolution_url: 'https://evo.example.com',
  evolution_instance: 'niver',
  evolution_webhook_secret_hash: 'h',
  evolution_phone: null,
  evolution_min_interval_ms: 6000,
  evolution_jitter_ms: 4000,
  evolution_broadcast_max: 50,
  status: 'connected',
  connected_at: '2026-11-01T00:00:00Z',
};

const thread = {
  contact: { contact: { id: 'ct-1' }, wasCreated: false },
  conversation: { id: 'cv-1' },
  conversationCreated: false,
};

const noSleep = { sleep: async () => {} };

function upsertEvent(over: { key?: Record<string, unknown>; message?: unknown } = {}) {
  return {
    event: 'messages.upsert',
    instance: 'niver',
    data: {
      key: { remoteJid: '5591988887777@s.whatsapp.net', fromMe: false, id: 'MSG1', ...over.key },
      pushName: 'Maria',
      message: over.message ?? { conversation: 'Oi!' },
      messageTimestamp: 1_780_000_000,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveInboundThread.mockResolvedValue(thread);
  h.persistOutboundFromPhone.mockResolvedValue(true);
});

describe('MESSAGES_UPSERT — received (fromMe=false)', () => {
  it('creates/finds the thread with the sender phone+name and hands the message to the shared pipeline', async () => {
    const { db } = fakeDb(); // messageExists → data null → não existe
    await processEvolutionEvent(db, row, upsertEvent(), noSleep);

    expect(h.resolveInboundThread).toHaveBeenCalledWith(
      { db, accountId: 'acc-1', configOwnerUserId: 'user-1' },
      '5591988887777',
      'Maria'
    );
    expect(h.persistAndDispatchInbound).toHaveBeenCalledTimes(1);
    const [, , msg] = h.persistAndDispatchInbound.mock.calls[0];
    expect(msg).toMatchObject({
      providerMessageId: 'MSG1',
      contentType: 'text',
      contentText: 'Oi!',
      timestampSeconds: 1_780_000_000,
      interactiveReplyId: null,
    });
    expect(h.persistOutboundFromPhone).not.toHaveBeenCalled();
  });

  it('ignores a duplicate delivery of the same message id', async () => {
    const { db } = fakeDb({ messages: { data: [{ id: 'existing' }] } });
    await processEvolutionEvent(db, row, upsertEvent(), noSleep);
    expect(h.resolveInboundThread).not.toHaveBeenCalled();
    expect(h.persistAndDispatchInbound).not.toHaveBeenCalled();
  });

  it('ignores groups, status updates and newsletters without touching the database', async () => {
    const { db, calls } = fakeDb();
    for (const remoteJid of ['1203@g.us', 'status@broadcast', '1203@newsletter']) {
      await processEvolutionEvent(db, row, upsertEvent({ key: { remoteJid } }), noSleep);
    }
    expect(h.resolveInboundThread).not.toHaveBeenCalled();
    expect(h.persistAndDispatchInbound).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('routes a reaction to message_reactions, not messages', async () => {
    const { db } = fakeDb();
    await processEvolutionEvent(
      db,
      row,
      upsertEvent({ message: { reactionMessage: { key: { id: 'T1' }, text: '👍' } } }),
      noSleep
    );
    expect(h.applyInboundReaction).toHaveBeenCalledWith(db, {
      conversationId: 'cv-1',
      contactId: 'ct-1',
      targetProviderId: 'T1',
      emoji: '👍',
    });
    expect(h.persistAndDispatchInbound).not.toHaveBeenCalled();
  });

  it('downloads media through the Evolution base64 endpoint and mirrors it', async () => {
    h.getMediaBase64.mockResolvedValue({ base64: 'QUJD', mimetype: 'image/jpeg', fileName: null });
    h.mirrorInboundMedia.mockResolvedValue('https://cdn.example.com/chat-media/x.jpg');
    const { db } = fakeDb();

    await processEvolutionEvent(
      db,
      row,
      upsertEvent({ message: { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' } } }),
      noSleep
    );

    expect(h.getMediaBase64).toHaveBeenCalledWith(
      { baseUrl: 'https://evo.example.com', instance: 'niver', apiKey: 'dec(enc-key)' },
      { messageId: 'MSG1' }
    );
    const mirrorArgs = h.mirrorInboundMedia.mock.calls[0][0];
    expect(mirrorArgs.accountId).toBe('acc-1');
    const fetched = await mirrorArgs.download();
    expect(fetched.buffer.toString()).toBe('ABC');
    const [, , msg] = h.persistAndDispatchInbound.mock.calls[0];
    expect(msg).toMatchObject({
      contentType: 'image',
      contentText: 'foto',
      mediaUrl: 'https://cdn.example.com/chat-media/x.jpg',
      mediaType: 'image/jpeg',
    });
  });

  it('keeps the message (with a placeholder) when the media cannot be fetched', async () => {
    h.getMediaBase64.mockRejectedValue(new Error('boom'));
    const { db } = fakeDb();
    await processEvolutionEvent(
      db,
      row,
      upsertEvent({ message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } } }),
      noSleep
    );
    const [, , msg] = h.persistAndDispatchInbound.mock.calls[0];
    expect(msg).toMatchObject({ contentType: 'audio', mediaUrl: null, contentText: '[mídia indisponível]' });
  });

  it('turns "2" into the tap of option 2 of the last numbered message', async () => {
    const { db } = fakeDb({
      messages: {
        data: [
          {
            sender_type: 'bot',
            content_type: 'interactive',
            interactive_payload: {
              kind: 'buttons',
              body: 'Como ajudamos?',
              buttons: [
                { id: 'reservar', title: 'Reservar' },
                { id: 'cardapio', title: 'Cardápio' },
              ],
            },
          },
        ],
      },
    });
    // O 1º select (messageExists) também lê `messages`; o fake devolve a
    // mesma linha, então força "não existe" no primeiro acesso.
    let first = true;
    const origFrom = (db as { from: (t: string) => unknown }).from.bind(db);
    (db as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'messages' && first) {
        first = false;
        return fakeDb().db.from('messages');
      }
      return origFrom(t);
    };

    await processEvolutionEvent(db, row, upsertEvent({ message: { conversation: '2' } }), noSleep);

    const [, , msg] = h.persistAndDispatchInbound.mock.calls[0];
    expect(msg).toMatchObject({
      contentType: 'interactive',
      interactiveReplyId: 'cardapio',
      contentText: 'Cardápio',
    });
  });
});

describe('MESSAGES_UPSERT — sent from the phone (fromMe=true)', () => {
  it('records it on the right conversation WITHOUT AI, automations or flows', async () => {
    const { db } = fakeDb(); // sem eco do wacrm → não existe
    await processEvolutionEvent(
      db,
      row,
      upsertEvent({ key: { fromMe: true, id: 'MINE1' }, message: { conversation: 'Já te respondo' } }),
      noSleep
    );

    expect(h.resolveInboundThread).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1' }),
      '5591988887777',
      '' // pushName de fromMe é o NOSSO nome: nunca renomeia o contato
    );
    expect(h.persistOutboundFromPhone).toHaveBeenCalledTimes(1);
    expect(h.persistOutboundFromPhone.mock.calls[0][2]).toMatchObject({
      providerMessageId: 'MINE1',
      contentText: 'Já te respondo',
    });

    expect(h.persistAndDispatchInbound).not.toHaveBeenCalled();
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
  });

  it('does not duplicate when the wacrm itself sent it (id already stored)', async () => {
    const { db } = fakeDb({ messages: { data: [{ id: 'row-from-send-message' }] } });
    await processEvolutionEvent(
      db,
      row,
      upsertEvent({ key: { fromMe: true, id: 'OURS1' } }),
      noSleep
    );
    expect(h.resolveInboundThread).not.toHaveBeenCalled();
    expect(h.persistOutboundFromPhone).not.toHaveBeenCalled();
  });

  it('waits before checking, so the wacrm send can store its row first', async () => {
    const sleep = vi.fn(async () => {});
    const { db } = fakeDb();
    await processEvolutionEvent(db, row, upsertEvent({ key: { fromMe: true } }), { sleep });
    expect(sleep).toHaveBeenCalledWith(2500);
  });
});

describe('MESSAGES_UPDATE', () => {
  it('maps DELIVERY_ACK to delivered, scoped to the account', async () => {
    const { db } = fakeDb();
    await processEvolutionEvent(
      db,
      row,
      { event: 'messages.update', data: { keyId: 'MINE1', status: 'DELIVERY_ACK', fromMe: true } },
      noSleep
    );
    expect(h.applyStatusUpdate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'MINE1', status: 'delivered' }),
      'acc-1'
    );
  });

  it('ignores receipts for customer messages and unknown statuses', async () => {
    const { db } = fakeDb();
    await processEvolutionEvent(
      db,
      row,
      { event: 'messages.update', data: { keyId: 'X', status: 'READ', fromMe: false } },
      noSleep
    );
    await processEvolutionEvent(
      db,
      row,
      { event: 'messages.update', data: { keyId: 'X', status: 'PENDING' } },
      noSleep
    );
    expect(h.applyStatusUpdate).not.toHaveBeenCalled();
  });
});

describe('CONNECTION_UPDATE', () => {
  it('marks the channel connected and stores the number', async () => {
    h.fetchConnectedNumber.mockResolvedValue('5591988887777');
    const { db, calls } = fakeDb();
    await processEvolutionEvent(
      db,
      { ...row, status: 'connecting', connected_at: null },
      { event: 'connection.update', data: { state: 'open' } },
      noSleep
    );
    const upd = calls.find((c) => c.table === 'whatsapp_config' && c.op === 'update')!;
    expect(upd.args[0]).toMatchObject({ status: 'connected', evolution_phone: '5591988887777' });
  });

  it('on a drop: marks disconnected and notifies owners/admins', async () => {
    const { db, calls } = fakeDb({
      profiles: { data: [{ user_id: 'u-owner' }, { user_id: 'u-admin' }] },
      notifications: { data: [] },
    });
    await processEvolutionEvent(
      db,
      row,
      { event: 'connection.update', data: { state: 'close', statusReason: 401 } },
      noSleep
    );

    const upd = calls.find((c) => c.table === 'whatsapp_config' && c.op === 'update')!;
    expect(upd.args[0]).toMatchObject({ status: 'disconnected', evolution_phone: null, connected_at: null });

    const ins = calls.find((c) => c.table === 'notifications' && c.op === 'insert')!;
    const rows = ins.args[0] as { user_id: string; type: string; account_id: string }[];
    expect(rows.map((r) => r.user_id)).toEqual(['u-owner', 'u-admin']);
    expect(rows.every((r) => r.type === 'whatsapp_disconnected' && r.account_id === 'acc-1')).toBe(true);
    // Só owner/admin recebem.
    const roleFilter = calls.find((c) => c.table === 'profiles' && c.op === 'in')!;
    expect(roleFilter.args).toEqual(['account_role', ['owner', 'admin']]);
  });

  it('does not notify for a QR attempt that never connected', async () => {
    const { db, calls } = fakeDb({ profiles: { data: [{ user_id: 'u-owner' }] } });
    await processEvolutionEvent(
      db,
      { ...row, status: 'connecting', connected_at: null },
      { event: 'connection.update', data: { state: 'close' } },
      noSleep
    );
    expect(calls.some((c) => c.table === 'notifications')).toBe(false);
  });
});

describe('robustness', () => {
  it('never throws, even when a downstream step blows up', async () => {
    h.resolveInboundThread.mockRejectedValue(new Error('db down'));
    const { db } = fakeDb();
    await expect(processEvolutionEvent(db, row, upsertEvent(), noSleep)).resolves.toBeUndefined();
  });

  it('skips events it does not consume', async () => {
    const { db, calls } = fakeDb();
    await processEvolutionEvent(db, row, { event: 'presence.update', data: {} }, noSleep);
    expect(calls).toHaveLength(0);
  });
});
