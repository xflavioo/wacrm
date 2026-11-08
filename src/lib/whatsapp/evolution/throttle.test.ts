import { describe, expect, it, vi } from 'vitest';

import { MAX_THROTTLE_WAIT_MS, SendQueueFullError, dbThrottle } from './throttle';

function dbReturning(result: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null, ...result });
  return { db: { rpc } as never, rpc };
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

describe('dbThrottle', () => {
  it('reserves a slot per account and recipient, scoped to the account', async () => {
    const { db, rpc } = dbReturning({ data: new Date(NOW).toISOString() });
    await dbThrottle(db, 'acc-1', { now: () => NOW, sleep: async () => {} })('5591988887777');
    expect(rpc).toHaveBeenCalledWith('claim_evolution_send_slot', {
      p_account_id: 'acc-1',
      p_to: '5591988887777',
    });
  });

  it('does not wait when the slot is now (same recipient / idle queue)', async () => {
    const sleep = vi.fn();
    const { db } = dbReturning({ data: new Date(NOW).toISOString() });
    await dbThrottle(db, 'acc-1', { now: () => NOW, sleep })('55');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps until the reserved slot', async () => {
    const sleep = vi.fn(async () => {});
    const { db } = dbReturning({ data: new Date(NOW + 7_300).toISOString() });
    await dbThrottle(db, 'acc-1', { now: () => NOW, sleep })('55');
    expect(sleep).toHaveBeenCalledWith(7_300);
  });

  it('fails clearly when the queue is too long for one request', async () => {
    const sleep = vi.fn();
    const { db } = dbReturning({ data: new Date(NOW + MAX_THROTTLE_WAIT_MS + 1000).toISOString() });
    const err = await dbThrottle(db, 'acc-1', { now: () => NOW, sleep })('55').catch((e) => e);
    expect(err).toBeInstanceOf(SendQueueFullError);
    expect(err.message).toMatch(/Fila de envio cheia/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never blocks a send just because the protection itself is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sleep = vi.fn();
    const { db } = dbReturning({ error: { message: 'function does not exist' } });
    await expect(dbThrottle(db, 'acc-1', { now: () => NOW, sleep })('55')).resolves.toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
