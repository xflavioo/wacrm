import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EvolutionError,
  assertInstanceName,
  connectInstance,
  fetchConnectedNumber,
  getConnectionState,
  getMediaBase64,
  logoutInstance,
  markAsRead,
  normalizeBaseUrl,
  sendAudio,
  sendMedia,
  sendPresence,
  sendReaction,
  sendText,
  setWebhook,
} from './client';

const creds = {
  baseUrl: 'https://evo.example.com/',
  instance: 'niver',
  apiKey: 'SECRET-KEY',
};

const fetchMock = vi.fn();

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === null ? '' : JSON.stringify(body), { status })
  );
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return {
    url: url as string,
    method: init.method as string,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('normalizeBaseUrl / assertInstanceName', () => {
  it('strips the trailing slash and keeps a sub-path', () => {
    expect(normalizeBaseUrl('https://evo.example.com/')).toBe('https://evo.example.com');
    expect(normalizeBaseUrl(' https://x.com/api/ ')).toBe('https://x.com/api');
  });

  it('rejects non-http(s), embedded credentials and garbage', () => {
    expect(() => normalizeBaseUrl('ftp://x.com')).toThrow(EvolutionError);
    expect(() => normalizeBaseUrl('https://user:pw@x.com')).toThrow(/usuário e senha/);
    expect(() => normalizeBaseUrl('not a url')).toThrow(/inválida/);
  });

  it('only accepts path-safe instance names', () => {
    expect(assertInstanceName(' niver-1 ')).toBe('niver-1');
    expect(() => assertInstanceName('a/b')).toThrow(EvolutionError);
    expect(() => assertInstanceName('')).toThrow(EvolutionError);
  });
});

describe('instance endpoints', () => {
  it('connectInstance GETs /instance/connect with the apikey header and returns a data URL', async () => {
    reply({ base64: 'AAAA', pairingCode: 'WZYE-H1YY' });
    const qr = await connectInstance(creds);
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/instance/connect/niver');
    expect(c.method).toBe('GET');
    expect(c.headers.apikey).toBe('SECRET-KEY');
    expect(qr.qrDataUrl).toBe('data:image/png;base64,AAAA');
    expect(qr.pairingCode).toBe('WZYE-H1YY');
  });

  it('connectInstance keeps an existing data URL and tolerates "already connected" ({})', async () => {
    reply({ base64: 'data:image/png;base64,BBBB' });
    expect((await connectInstance(creds)).qrDataUrl).toBe('data:image/png;base64,BBBB');
    reply({});
    expect((await connectInstance(creds)).qrDataUrl).toBeNull();
  });

  it('getConnectionState normalizes the state', async () => {
    reply({ instance: { instanceName: 'niver', state: 'open' } });
    expect(await getConnectionState(creds)).toBe('open');
    reply({ instance: { state: 'connecting' } });
    expect(await getConnectionState(creds)).toBe('connecting');
    reply({ instance: { state: 'close' } });
    expect(await getConnectionState(creds)).toBe('close');
    expect(lastCall().url).toBe('https://evo.example.com/instance/connectionState/niver');
  });

  it('fetchConnectedNumber extracts digits from ownerJid', async () => {
    reply([{ ownerJid: '5591988887777@s.whatsapp.net' }]);
    expect(await fetchConnectedNumber(creds)).toBe('5591988887777');
    expect(lastCall().url).toContain('/instance/fetchInstances?instanceName=niver');
    reply([]);
    expect(await fetchConnectedNumber(creds)).toBeNull();
  });

  it('logoutInstance sends DELETE /instance/logout', async () => {
    reply({ status: 'SUCCESS' });
    await logoutInstance(creds);
    expect(lastCall()).toMatchObject({
      url: 'https://evo.example.com/instance/logout/niver',
      method: 'DELETE',
    });
  });
});

describe('setWebhook', () => {
  it('sends the nested v2.2+ shape with the four events', async () => {
    reply({ ok: true });
    await setWebhook(creds, 'https://crm.example.com/api/evolution/webhook/abc');
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/webhook/set/niver');
    expect(c.body.webhook).toMatchObject({
      enabled: true,
      url: 'https://crm.example.com/api/evolution/webhook/abc',
      byEvents: false,
      base64: false,
    });
    expect(c.body.webhook.events).toEqual([
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
      'QRCODE_UPDATED',
    ]);
  });

  it('falls back to the flat v2.0/2.1 shape when the server answers 400', async () => {
    reply({ message: ['instance requires property "url"'] }, 400);
    reply({ ok: true });
    await setWebhook(creds, 'https://crm.example.com/h');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const c = lastCall();
    expect(c.body.webhook).toBeUndefined();
    expect(c.body).toMatchObject({ enabled: true, url: 'https://crm.example.com/h', webhookByEvents: false });
  });

  it('does not retry on 401', async () => {
    reply({ message: 'Unauthorized' }, 401);
    await expect(setWebhook(creds, 'https://x/h')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sending', () => {
  it('sendText posts number/text/delay/quoted and returns key.id', async () => {
    reply({ key: { remoteJid: '5591@s.whatsapp.net', fromMe: true, id: 'BAE5' } });
    const r = await sendText(creds, {
      number: '5591988887777',
      text: 'Olá!',
      delayMs: 1500,
      quotedMessageId: 'Q1',
    });
    expect(r.messageId).toBe('BAE5');
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/message/sendText/niver');
    expect(c.method).toBe('POST');
    expect(c.body).toEqual({
      number: '5591988887777',
      text: 'Olá!',
      delay: 1500,
      quoted: { key: { id: 'Q1' } },
    });
  });

  it('sendText fails clearly when the server omits the message id', async () => {
    reply({ status: 'PENDING' });
    await expect(sendText(creds, { number: '1', text: 'x' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('sendMedia posts mediatype/media/caption/fileName', async () => {
    reply({ key: { id: 'M1' } });
    await sendMedia(creds, {
      number: '5591988887777',
      mediatype: 'document',
      media: 'https://cdn/x.pdf',
      caption: 'Cardápio',
      fileName: 'cardapio.pdf',
    });
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/message/sendMedia/niver');
    expect(c.body).toEqual({
      number: '5591988887777',
      mediatype: 'document',
      media: 'https://cdn/x.pdf',
      caption: 'Cardápio',
      fileName: 'cardapio.pdf',
    });
  });

  it('sendAudio uses the PTT endpoint (voice note)', async () => {
    reply({ key: { id: 'A1' } });
    const r = await sendAudio(creds, { number: '5591988887777', audio: 'https://cdn/a.ogg' });
    expect(r.messageId).toBe('A1');
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/message/sendWhatsAppAudio/niver');
    expect(c.body).toMatchObject({ number: '5591988887777', audio: 'https://cdn/a.ogg', encoding: true });
  });

  it('sendReaction posts the target key and emoji', async () => {
    reply({ key: { id: 'R1' } });
    await sendReaction(creds, {
      remoteJid: '5591988887777@s.whatsapp.net',
      targetMessageId: 'T1',
      fromMe: false,
      emoji: '👍',
    });
    expect(lastCall().body).toEqual({
      key: { remoteJid: '5591988887777@s.whatsapp.net', fromMe: false, id: 'T1' },
      reaction: '👍',
    });
  });
});

describe('chat endpoints', () => {
  it('sendPresence defaults to composing', async () => {
    reply({});
    await sendPresence(creds, { number: '5591988887777' });
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/chat/sendPresence/niver');
    expect(c.body).toEqual({ number: '5591988887777', presence: 'composing', delay: 1200 });
  });

  it('markAsRead sends readMessages with the message key', async () => {
    reply({});
    await markAsRead(creds, { remoteJid: '5591@s.whatsapp.net', messageId: 'X1' });
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/chat/markMessageAsRead/niver');
    expect(c.body).toEqual({
      readMessages: [{ remoteJid: '5591@s.whatsapp.net', fromMe: false, id: 'X1' }],
    });
  });

  it('getMediaBase64 strips a data-URL prefix', async () => {
    reply({ base64: 'data:image/jpeg;base64,/9j/4AAQ', mimetype: 'image/jpeg', fileName: 'a.jpg' });
    const m = await getMediaBase64(creds, { messageId: 'IMG1' });
    expect(m).toEqual({ base64: '/9j/4AAQ', mimetype: 'image/jpeg', fileName: 'a.jpg' });
    const c = lastCall();
    expect(c.url).toBe('https://evo.example.com/chat/getBase64FromMediaMessage/niver');
    expect(c.body).toEqual({ message: { key: { id: 'IMG1' } }, convertToMp4: false });
  });
});

describe('error handling', () => {
  it('maps HTTP failures to pt-BR messages and never leaks the API key', async () => {
    reply({ message: 'Unauthorized' }, 401);
    const e1 = await sendText(creds, { number: '1', text: 'x' }).catch((e) => e);
    expect(e1).toBeInstanceOf(EvolutionError);
    expect(e1.code).toBe('unauthorized');
    expect(e1.message).toMatch(/API key/);
    expect(e1.message).not.toContain('SECRET-KEY');

    reply({ response: { message: ['Instance not found'] } }, 404);
    const e2 = await getConnectionState(creds).catch((e) => e);
    expect(e2.code).toBe('not_found');
    expect(e2.message).toContain('Instance not found');

    reply({ message: 'boom' }, 500);
    const e3 = await getConnectionState(creds).catch((e) => e);
    expect(e3.code).toBe('server');
    expect(e3.status).toBe(500);
  });

  it('reports a network failure and a timeout distinctly', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(getConnectionState(creds)).rejects.toMatchObject({ code: 'network' });

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort);
    await expect(getConnectionState(creds)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('passes an abort signal so requests can time out', async () => {
    reply({ instance: { state: 'open' } });
    await getConnectionState(creds);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
