import { describe, expect, it, vi } from 'vitest';

import {
  FreeBroadcastError,
  sendFreeBroadcastBatch,
  validateFreeMessage,
} from './free-broadcast';
import type { WhatsAppProvider } from '@/lib/whatsapp/provider/types';

function fakeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    kind: 'evolution',
    addressVariants: (p: string) => [p],
    isRetryableAddressError: () => false,
    sendText: vi.fn(async ({ to }) => ({ messageId: `T-${to}` })),
    sendMedia: vi.fn(async ({ to }) => ({ messageId: `M-${to}` })),
    sendAudio: vi.fn(),
    sendTemplate: vi.fn(),
    sendInteractiveButtons: vi.fn(),
    sendInteractiveList: vi.fn(),
    sendReaction: vi.fn(),
    ...overrides,
  } as unknown as WhatsAppProvider;
}

describe('validateFreeMessage', () => {
  it('accepts a plain text message', () => {
    expect(validateFreeMessage({ text: '  Olá!  ' })).toEqual({
      text: 'Olá!',
      mediaUrl: null,
      mediaKind: null,
    });
  });

  it('accepts media with a caption and requires a valid kind', () => {
    expect(
      validateFreeMessage({ text: 'Veja', mediaUrl: 'https://cdn.example.com/a.jpg', mediaKind: 'image' })
    ).toMatchObject({ mediaUrl: 'https://cdn.example.com/a.jpg', mediaKind: 'image' });

    expect(() =>
      validateFreeMessage({ text: 'x', mediaUrl: 'https://cdn.example.com/a.jpg', mediaKind: 'audio' })
    ).toThrow(/tipo da mídia/);
  });

  it.each([
    [undefined, /Informe a mensagem/],
    [{ text: '   ' }, /Escreva o texto/],
    [{ text: 'x', mediaUrl: 'ftp://x/y', mediaKind: 'image' }, /http/],
    [{ text: 'x', mediaUrl: 'nope', mediaKind: 'image' }, /inválida/],
    [{ text: 'a'.repeat(4097) }, /4096/],
    [{ text: 'a'.repeat(1025), mediaUrl: 'https://x.com/a.jpg', mediaKind: 'image' }, /legenda/],
  ])('rejects %j', (input, message) => {
    expect(() => validateFreeMessage(input)).toThrow(FreeBroadcastError);
    expect(() => validateFreeMessage(input)).toThrow(message);
  });
});

describe('sendFreeBroadcastBatch', () => {
  it('sends text through the provider, per-recipient text overriding the default', async () => {
    const provider = fakeProvider();
    const results = await sendFreeBroadcastBatch(
      provider,
      [
        { phone: '+55 91 98888-7777', text: 'Oi Maria!' },
        { phone: '5591977776666' },
      ],
      { text: 'Oi!' }
    );

    expect(results).toEqual([
      { phone: '+55 91 98888-7777', status: 'sent', whatsapp_message_id: 'T-5591988887777' },
      { phone: '5591977776666', status: 'sent', whatsapp_message_id: 'T-5591977776666' },
    ]);
    expect(provider.sendText).toHaveBeenNthCalledWith(1, { to: '5591988887777', text: 'Oi Maria!' });
    expect(provider.sendText).toHaveBeenNthCalledWith(2, { to: '5591977776666', text: 'Oi!' });
  });

  it('sends media with the text as caption (and a file name for documents)', async () => {
    const provider = fakeProvider();
    await sendFreeBroadcastBatch(
      provider,
      [{ phone: '5591988887777' }],
      { text: 'Cardápio', mediaUrl: 'https://cdn.example.com/files/cardapio%20novo.pdf', mediaKind: 'document' }
    );
    expect(provider.sendMedia).toHaveBeenCalledWith({
      to: '5591988887777',
      kind: 'document',
      link: 'https://cdn.example.com/files/cardapio%20novo.pdf',
      caption: 'Cardápio',
      filename: 'cardapio novo.pdf',
    });
    expect(provider.sendText).not.toHaveBeenCalled();
  });

  it('one failure never aborts the others', async () => {
    const provider = fakeProvider({
      sendText: vi
        .fn()
        .mockResolvedValueOnce({ messageId: 'A' })
        .mockRejectedValueOnce(new Error('O Evolution recusou a requisição'))
        .mockResolvedValueOnce({ messageId: 'C' }),
    });
    const results = await sendFreeBroadcastBatch(
      provider,
      [{ phone: '5591900000001' }, { phone: '5591900000002' }, { phone: '5591900000003' }],
      { text: 'oi' }
    );
    expect(results.map((r) => r.status)).toEqual(['sent', 'failed', 'sent']);
    expect(results[1].error).toBe('O Evolution recusou a requisição');
  });

  it('flags an invalid phone without calling the provider', async () => {
    const provider = fakeProvider();
    const [r] = await sendFreeBroadcastBatch(provider, [{ phone: 'abc' }], { text: 'oi' });
    expect(r).toMatchObject({ status: 'failed', error: 'Número de telefone inválido.' });
    expect(provider.sendText).not.toHaveBeenCalled();
  });
});
