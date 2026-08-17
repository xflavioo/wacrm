import { describe, expect, it, vi } from 'vitest';
import { sendWithAddressRetry } from './retry';
import type { WhatsAppProvider } from './types';

/** Provedor de mentira com política de endereço controlável. */
function fakeProvider(
  variants: string[],
  retryable: (e: unknown) => boolean
): WhatsAppProvider {
  return {
    kind: 'meta',
    addressVariants: () => variants,
    isRetryableAddressError: retryable,
  } as unknown as WhatsAppProvider;
}

describe('sendWithAddressRetry', () => {
  it('returns on the first address that succeeds', async () => {
    const attempt = vi.fn(async () => 'wamid.OK');
    const result = await sendWithAddressRetry(
      fakeProvider(['A', 'B'], () => true),
      'A',
      attempt
    );

    expect(result).toEqual({ messageId: 'wamid.OK', workingAddress: 'A' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('advances to the next address on a retryable error', async () => {
    const attempt = vi.fn(async (addr: string) => {
      if (addr === 'A') throw new Error('(#131030) not in allowed list');
      return 'wamid.OK';
    });

    const result = await sendWithAddressRetry(
      fakeProvider(['A', 'B'], (e) => String(e).includes('131030')),
      'A',
      attempt
    );

    expect(result).toEqual({ messageId: 'wamid.OK', workingAddress: 'B' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  // Erro não-retryable tem que subir IMEDIATAMENTE. Um "invalid token"
  // repetido em três variantes são três chamadas inúteis e três chances
  // de rate limit.
  it('rethrows a non-retryable error without trying the next address', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('invalid access token');
    });

    await expect(
      sendWithAddressRetry(
        fakeProvider(['A', 'B'], () => false),
        'A',
        attempt
      )
    ).rejects.toThrow('invalid access token');

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('throws the last error when every address is exhausted', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('(#131030) not in allowed list');
    });

    await expect(
      sendWithAddressRetry(
        fakeProvider(['A', 'B'], () => true),
        'A',
        attempt
      )
    ).rejects.toThrow('131030');

    expect(attempt).toHaveBeenCalledTimes(2);
  });

  // Um provedor sem variantes (Evolution) não pode virar zero tentativas.
  it('falls back to the given address when the provider yields no variants', async () => {
    const attempt = vi.fn(async () => 'wamid.OK');
    const result = await sendWithAddressRetry(
      fakeProvider([], () => false),
      'A',
      attempt
    );

    expect(result).toEqual({ messageId: 'wamid.OK', workingAddress: 'A' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
