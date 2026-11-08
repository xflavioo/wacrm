import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  sendAudio: vi.fn(),
  sendReaction: vi.fn(),
  sendPresence: vi.fn(),
  markAsRead: vi.fn(),
}));

vi.mock('./client', async (orig) => ({
  ...(await orig<typeof import('./client')>()),
  sendText: h.sendText,
  sendMedia: h.sendMedia,
  sendAudio: h.sendAudio,
  sendReaction: h.sendReaction,
  sendPresence: h.sendPresence,
  markAsRead: h.markAsRead,
}));

import { evolutionProvider, typingDelayMs, TEMPLATES_UNSUPPORTED_MESSAGE } from './provider';
import { EvolutionError } from './client';

const creds = { baseUrl: 'https://evo.example.com', instance: 'niver', apiKey: 'k' };

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [h.sendText, h.sendMedia, h.sendAudio, h.sendReaction]) {
    fn.mockResolvedValue({ messageId: 'EVO-ID' });
  }
});

describe('evolutionProvider', () => {
  it('identifies itself and uses a single address (no Meta sandbox variants)', () => {
    const p = evolutionProvider(creds);
    expect(p.kind).toBe('evolution');
    expect(p.addressVariants('5591988887777')).toEqual(['5591988887777']);
    expect(p.isRetryableAddressError(new Error('131030 not in allowed list'))).toBe(false);
  });

  it('sendText throttles first, then sends with a typing delay and the quoted id', async () => {
    const order: string[] = [];
    const throttle = vi.fn(async () => {
      order.push('throttle');
    });
    h.sendText.mockImplementation(async () => {
      order.push('send');
      return { messageId: 'T1' };
    });

    const r = await evolutionProvider(creds, { throttle }).sendText({
      to: '5591988887777',
      text: 'Olá, tudo bem?',
      contextMessageId: 'PARENT',
    });

    expect(r).toEqual({ messageId: 'T1' });
    expect(order).toEqual(['throttle', 'send']);
    expect(throttle).toHaveBeenCalledWith('5591988887777');
    expect(h.sendText).toHaveBeenCalledWith(creds, {
      number: '5591988887777',
      text: 'Olá, tudo bem?',
      delayMs: typingDelayMs('Olá, tudo bem?'),
      quotedMessageId: 'PARENT',
    });
  });

  it('does not send when the queue throttle rejects', async () => {
    const throttle = vi.fn().mockRejectedValue(new Error('fila cheia'));
    await expect(
      evolutionProvider(creds, { throttle }).sendText({ to: '1', text: 'x' })
    ).rejects.toThrow('fila cheia');
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('typing delay stays between 0.6 s and 1.8 s', () => {
    expect(typingDelayMs('')).toBe(600);
    expect(typingDelayMs('x'.repeat(10_000))).toBe(1800);
  });

  it('sendMedia maps image/video/document to the media endpoint', async () => {
    const p = evolutionProvider(creds);
    await p.sendMedia({ to: '55', kind: 'image', link: 'https://cdn/a.jpg', caption: 'Festa' });
    expect(h.sendMedia).toHaveBeenLastCalledWith(
      creds,
      expect.objectContaining({ number: '55', mediatype: 'image', media: 'https://cdn/a.jpg', caption: 'Festa' })
    );

    await p.sendMedia({ to: '55', kind: 'document', link: 'https://cdn/x.pdf', filename: 'cardapio.pdf' });
    expect(h.sendMedia).toHaveBeenLastCalledWith(
      creds,
      expect.objectContaining({
        mediatype: 'document',
        fileName: 'cardapio.pdf',
        mimetype: 'application/pdf',
      })
    );
  });

  it('audio goes out as a voice note (PTT endpoint), from sendMedia and from sendAudio', async () => {
    const p = evolutionProvider(creds);
    await p.sendMedia({ to: '55', kind: 'audio', link: 'https://cdn/a.ogg' });
    await p.sendAudio({ to: '55', link: 'https://cdn/b.ogg' });
    expect(h.sendAudio).toHaveBeenCalledTimes(2);
    expect(h.sendMedia).not.toHaveBeenCalled();
    expect(h.sendAudio).toHaveBeenLastCalledWith(
      creds,
      expect.objectContaining({ number: '55', audio: 'https://cdn/b.ogg' })
    );
  });

  it('interactive buttons are sent as numbered text', async () => {
    await evolutionProvider(creds).sendInteractiveButtons({
      to: '55',
      bodyText: 'Como podemos ajudar?',
      buttons: [
        { id: 'reservar', title: 'Reservar festa' },
        { id: 'cardapio', title: 'Ver cardápio' },
      ],
    });
    const sent = h.sendText.mock.calls[0][1].text as string;
    expect(sent).toContain('Como podemos ajudar?');
    expect(sent).toContain('1) Reservar festa');
    expect(sent).toContain('2) Ver cardápio');
    expect(sent).toContain('Responda com o número da opção (1 a 2).');
  });

  it('interactive lists are numbered across sections, with row descriptions', async () => {
    await evolutionProvider(creds).sendInteractiveList({
      to: '55',
      bodyText: 'Escolha um pacote',
      buttonLabel: 'Ver',
      sections: [
        { title: 'A', rows: [{ id: 'p1', title: 'Básico', description: '2 horas' }] },
        { title: 'B', rows: [{ id: 'p2', title: 'Completo' }, { id: 'p3', title: 'Premium' }] },
      ],
    });
    const sent = h.sendText.mock.calls[0][1].text as string;
    expect(sent).toContain('1) Básico\n    2 horas');
    expect(sent).toContain('2) Completo');
    expect(sent).toContain('3) Premium');
    expect(sent).toContain('(1 a 3)');
  });

  it('templates are refused with a clear pt-BR message and nothing is sent', async () => {
    const err = await evolutionProvider(creds)
      .sendTemplate({ to: '55', templateName: 'promo' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EvolutionError);
    expect(err.message).toBe(TEMPLATES_UNSUPPORTED_MESSAGE);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('reaction targets the contact JID; typing and read receipts are available', async () => {
    const p = evolutionProvider(creds);
    await p.sendReaction({ to: '5591988887777', targetMessageId: 'T1', emoji: '👍' });
    expect(h.sendReaction).toHaveBeenCalledWith(creds, {
      remoteJid: '5591988887777@s.whatsapp.net',
      targetMessageId: 'T1',
      fromMe: false,
      emoji: '👍',
    });

    await p.sendTyping!({ to: '5591988887777', durationMs: 2000 });
    expect(h.sendPresence).toHaveBeenCalledWith(creds, {
      number: '5591988887777',
      presence: 'composing',
      delayMs: 2000,
    });

    await p.markRead!({ to: '5591988887777', messageId: 'IN1' });
    expect(h.markAsRead).toHaveBeenCalledWith(creds, {
      remoteJid: '5591988887777@s.whatsapp.net',
      messageId: 'IN1',
      fromMe: false,
    });
  });
});
