import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.TEXT' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.MEDIA' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.TPL' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.BTN' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.LIST' })),
  sendReactionMessage: vi.fn(async () => ({ messageId: 'wamid.REACT' })),
}));

import * as metaApi from '@/lib/whatsapp/meta-api';
import { phoneVariants } from '@/lib/whatsapp/phone-utils';
import { metaProvider } from './meta';

const CREDS = { phoneNumberId: 'pn-1', accessToken: 'tok-1' };

describe('metaProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('identifies as meta', () => {
    expect(metaProvider(CREDS).kind).toBe('meta');
  });

  it('forwards credentials and args to sendTextMessage', async () => {
    const result = await metaProvider(CREDS).sendText({
      to: '37063949836',
      text: 'oi',
      contextMessageId: 'wamid.PARENT',
    });

    expect(result).toEqual({ messageId: 'wamid.TEXT' });
    expect(metaApi.sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      text: 'oi',
      contextMessageId: 'wamid.PARENT',
    });
  });

  it('forwards media args including filename and caption', async () => {
    await metaProvider(CREDS).sendMedia({
      to: '37063949836',
      kind: 'document',
      link: 'https://example.com/a.pdf',
      caption: 'contrato',
      filename: 'a.pdf',
    });

    expect(metaApi.sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      kind: 'document',
      link: 'https://example.com/a.pdf',
      caption: 'contrato',
      filename: 'a.pdf',
      contextMessageId: undefined,
    });
  });

  // O retry de trunk-0 é política da Meta e tem que continuar sendo dela.
  // Este teste afirma a DELEGAÇÃO, não a lista de variantes — a lista
  // já é coberta por phone-utils.test.ts e duplicá-la aqui só criaria
  // um segundo lugar para atualizar quando a heurística mudar.
  it('delegates its address policy to phoneVariants', () => {
    const variants = metaProvider(CREDS).addressVariants('37063949836');

    expect(variants).toEqual(phoneVariants('37063949836'));
    // Sanidade: a política da Meta produz mais de um candidato.
    expect(variants.length).toBeGreaterThan(1);
    expect(variants[0]).toBe('37063949836');
  });

  // sendAudio existe para a Evolution ter onde encaixar o endpoint
  // dedicado de PTT. Na Meta é o mesmo endpoint de mídia — e este
  // teste trava esse mapeamento para ninguém "otimizar" o método fora.
  it('maps sendAudio onto the Meta media endpoint with kind=audio', async () => {
    await metaProvider(CREDS).sendAudio({
      to: '37063949836',
      link: 'https://example.com/nota.ogg',
    });

    expect(metaApi.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok-1',
        to: '37063949836',
        kind: 'audio',
        link: 'https://example.com/nota.ogg',
      })
    );
  });

  // Recebe o erro cru: Error, string, ou qualquer coisa que um fetch
  // rejeitado possa lançar. Só o texto do 131030 é retryable.
  it('treats Meta error 131030 as a retryable address error', () => {
    const p = metaProvider(CREDS);
    expect(
      p.isRetryableAddressError(new Error('(#131030) not in allowed list'))
    ).toBe(true);
    expect(p.isRetryableAddressError('recipient not in the allowed list')).toBe(
      true
    );
    expect(p.isRetryableAddressError(new Error('rate limit hit'))).toBe(false);
    expect(p.isRetryableAddressError(undefined)).toBe(false);
  });

  // Os três forwards mais pesados. Um typo de campo o TS pega (excess
  // property check); um CROSS-WIRE de campos do mesmo tipo — header no
  // footer, templateName no language — compila em silêncio. Estes
  // testes existem para esse caso, e sendTemplate é o caminho de
  // broadcast, o de maior volume do app.
  it('forwards every template field, including messageParams', async () => {
    const template = { id: 't-1', name: 'promo' } as never;
    const messageParams = { body: ['Ana'] } as never;
    await metaProvider(CREDS).sendTemplate({
      to: '37063949836',
      templateName: 'promo',
      language: 'pt_BR',
      template,
      messageParams,
      params: ['Ana'],
      contextMessageId: 'wamid.PARENT',
    });

    expect(metaApi.sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      templateName: 'promo',
      language: 'pt_BR',
      template,
      messageParams,
      params: ['Ana'],
      contextMessageId: 'wamid.PARENT',
    });
  });

  it('forwards interactive-button fields without cross-wiring header/footer', async () => {
    const buttons = [{ id: 'b1', title: 'Sim' }];
    await metaProvider(CREDS).sendInteractiveButtons({
      to: '37063949836',
      bodyText: 'Confirma?',
      buttons,
      headerText: 'HEADER',
      footerText: 'FOOTER',
    });

    expect(metaApi.sendInteractiveButtons).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      bodyText: 'Confirma?',
      buttons,
      headerText: 'HEADER',
      footerText: 'FOOTER',
      contextMessageId: undefined,
    });
  });

  it('forwards interactive-list fields without cross-wiring header/footer', async () => {
    const sections = [{ title: 'S', rows: [{ id: 'r1', title: 'Um' }] }];
    await metaProvider(CREDS).sendInteractiveList({
      to: '37063949836',
      bodyText: 'Escolha',
      buttonLabel: 'Ver',
      sections,
      headerText: 'HEADER',
      footerText: 'FOOTER',
    });

    expect(metaApi.sendInteractiveList).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      bodyText: 'Escolha',
      buttonLabel: 'Ver',
      sections,
      headerText: 'HEADER',
      footerText: 'FOOTER',
      contextMessageId: undefined,
    });
  });

  it('returns the reaction wamid instead of discarding it', async () => {
    const result = await metaProvider(CREDS).sendReaction({
      to: '37063949836',
      targetMessageId: 'wamid.TARGET',
      emoji: '👍',
    });

    expect(result).toEqual({ messageId: 'wamid.REACT' });
    expect(metaApi.sendReactionMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '37063949836',
      targetMessageId: 'wamid.TARGET',
      emoji: '👍',
    });
  });
});
