import { describe, expect, it } from 'vitest';

import {
  EnvelopeSchema,
  UpsertDataSchema,
  convertUpsert,
  mapEvolutionStatus,
  normalizeEventName,
  type ConvertedMessage,
  type ConvertedReaction,
} from './payload';
import { jidKind, normalizeBrazilianMobile, phoneFromJid } from './jid';

const TS = 1_780_000_000;
const JID = '5591988887777@s.whatsapp.net';

function upsert(
  message: Record<string, unknown> | null,
  key: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  return UpsertDataSchema.parse({
    key: { remoteJid: JID, fromMe: false, id: 'MSG1', ...key },
    pushName: 'Maria',
    message,
    messageTimestamp: TS,
    ...extra,
  });
}

function asMessage(data: ReturnType<typeof upsert>): ConvertedMessage {
  const r = convertUpsert(data);
  if (r.kind !== 'message') throw new Error(`expected message, got ${r.kind}`);
  return r;
}

describe('message types', () => {
  it('plain text (conversation)', () => {
    const m = asMessage(upsert({ conversation: 'Oi, tudo bem?' }));
    expect(m).toMatchObject({
      fromMe: false,
      phone: '5591988887777',
      contactName: 'Maria',
      providerMessageId: 'MSG1',
      timestampSeconds: TS,
      contentType: 'text',
      contentText: 'Oi, tudo bem?',
      media: null,
      interactiveReplyId: null,
    });
  });

  it('extended text, with the swipe-reply target', () => {
    const m = asMessage(
      upsert({
        extendedTextMessage: {
          text: 'Sim!',
          contextInfo: { stanzaId: 'PARENT1' },
        },
      })
    );
    expect(m.contentType).toBe('text');
    expect(m.contentText).toBe('Sim!');
    expect(m.replyToProviderId).toBe('PARENT1');
  });

  it('image with caption', () => {
    const m = asMessage(upsert({ imageMessage: { caption: 'Olha a festa', mimetype: 'image/jpeg' } }));
    expect(m.contentType).toBe('image');
    expect(m.contentText).toBe('Olha a festa');
    expect(m.media).toEqual({ kind: 'image', mimetype: 'image/jpeg', fileName: null });
  });

  it('video', () => {
    const m = asMessage(upsert({ videoMessage: { mimetype: 'video/mp4' } }));
    expect(m.contentType).toBe('video');
    expect(m.media?.kind).toBe('video');
    expect(m.contentText).toBeNull();
  });

  it('audio, including a push-to-talk voice note', () => {
    const plain = asMessage(upsert({ audioMessage: { mimetype: 'audio/mpeg' } }));
    expect(plain).toMatchObject({ contentType: 'audio', rawType: 'audio' });

    const ptt = asMessage(
      upsert({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7 } })
    );
    expect(ptt).toMatchObject({ contentType: 'audio', rawType: 'voice' });
    expect(ptt.media).toEqual({ kind: 'audio', mimetype: 'audio/ogg; codecs=opus', fileName: null });
  });

  it('document keeps the file name (and uses it as text without a caption)', () => {
    const m = asMessage(
      upsert({ documentMessage: { fileName: 'orcamento.pdf', mimetype: 'application/pdf' } })
    );
    expect(m.contentType).toBe('document');
    expect(m.contentText).toBe('orcamento.pdf');
    expect(m.media).toEqual({ kind: 'document', mimetype: 'application/pdf', fileName: 'orcamento.pdf' });
  });

  it('document inside documentWithCaptionMessage (unwrapped)', () => {
    const m = asMessage(
      upsert({
        documentWithCaptionMessage: {
          message: { documentMessage: { fileName: 'a.pdf', caption: 'Segue', mimetype: 'application/pdf' } },
        },
      })
    );
    expect(m.contentType).toBe('document');
    expect(m.contentText).toBe('Segue');
  });

  it('sticker is stored as an image', () => {
    const m = asMessage(upsert({ stickerMessage: { mimetype: 'image/webp' } }));
    expect(m.contentType).toBe('image');
    expect(m.rawType).toBe('sticker');
    expect(m.media?.kind).toBe('sticker');
  });

  it('location becomes name - address - lat,lng', () => {
    const m = asMessage(
      upsert({
        locationMessage: {
          degreesLatitude: -1.45,
          degreesLongitude: -48.49,
          name: 'Niverlândia',
          address: 'Belém/PA',
        },
      })
    );
    expect(m.contentType).toBe('location');
    expect(m.contentText).toBe('Niverlândia - Belém/PA - -1.45,-48.49');
  });

  it('contact card becomes readable text with the number', () => {
    const m = asMessage(
      upsert({
        contactMessage: {
          displayName: 'João Silva',
          vcard: 'BEGIN:VCARD\nTEL;waid=5591977776666:+55 91 97777-6666\nEND:VCARD',
        },
      })
    );
    expect(m.contentType).toBe('text');
    expect(m.contentText).toBe('👤 João Silva — 5591977776666');
  });

  it('reaction is returned as a reaction, not a message', () => {
    const r = convertUpsert(
      upsert({ reactionMessage: { key: { id: 'TARGET1' }, text: '❤️' } })
    ) as ConvertedReaction;
    expect(r.kind).toBe('reaction');
    expect(r.targetProviderId).toBe('TARGET1');
    expect(r.emoji).toBe('❤️');
  });

  it('an empty reaction text means "removed"', () => {
    const r = convertUpsert(
      upsert({ reactionMessage: { key: { id: 'TARGET1' }, text: '' } })
    ) as ConvertedReaction;
    expect(r.emoji).toBe('');
  });

  it('button and list answers carry the tapped id', () => {
    const b = asMessage(
      upsert({ buttonsResponseMessage: { selectedButtonId: 'btn_reserva', selectedDisplayText: 'Reservar' } })
    );
    expect(b).toMatchObject({ contentType: 'interactive', interactiveReplyId: 'btn_reserva', contentText: 'Reservar' });

    const l = asMessage(
      upsert({
        listResponseMessage: { title: 'Cardápio', singleSelectReply: { selectedRowId: 'row_menu' } },
      })
    );
    expect(l).toMatchObject({ contentType: 'interactive', interactiveReplyId: 'row_menu', contentText: 'Cardápio' });
  });

  it('view-once / ephemeral wrappers are unwrapped', () => {
    const m = asMessage(
      upsert({ ephemeralMessage: { message: { conversation: 'mensagem temporária' } } })
    );
    expect(m.contentText).toBe('mensagem temporária');
  });

  it('an unknown type becomes a text placeholder instead of breaking', () => {
    const m = asMessage(upsert({ pollCreationMessage: { name: 'Qual dia?' } }));
    expect(m).toMatchObject({
      contentType: 'text',
      contentText: '[tipo não suportado]',
      rawType: 'pollCreationMessage',
    });
  });

  it('protocol-only messages are ignored', () => {
    expect(convertUpsert(upsert({ protocolMessage: { type: 0 } }))).toEqual({
      kind: 'ignore',
      reason: 'protocol',
    });
  });

  it('a payload without message content is ignored', () => {
    expect(convertUpsert(upsert(null))).toEqual({ kind: 'ignore', reason: 'no_message' });
  });
});

describe('chat filtering', () => {
  it.each([
    ['120363025246125486@g.us', 'group'],
    ['status@broadcast', 'status'],
    ['120363025246125486@newsletter', 'newsletter'],
    ['5591988887777@broadcast', 'broadcast'],
  ])('ignores %s', (remoteJid, reason) => {
    const r = convertUpsert(upsert({ conversation: 'oi' }, { remoteJid }));
    expect(r).toEqual({ kind: 'ignore', reason });
  });
});

describe('phone resolution', () => {
  const LID = '184455667788990@lid';

  it('uses remoteJidAlt when the chat is addressed by LID', () => {
    const m = asMessage(
      upsert({ conversation: 'oi' }, { remoteJid: LID, remoteJidAlt: '5591988887777@s.whatsapp.net' })
    );
    expect(m.phone).toBe('5591988887777');
  });

  it('falls back to senderPn (key or data level)', () => {
    expect(
      asMessage(upsert({ conversation: 'oi' }, { remoteJid: LID, senderPn: '5591988887777@s.whatsapp.net' })).phone
    ).toBe('5591988887777');
    expect(
      asMessage(upsert({ conversation: 'oi' }, { remoteJid: LID }, { senderPn: '5591988887777@s.whatsapp.net' })).phone
    ).toBe('5591988887777');
  });

  it('never turns a bare LID into a phone — the message is dropped', () => {
    expect(convertUpsert(upsert({ conversation: 'oi' }, { remoteJid: LID }))).toEqual({
      kind: 'ignore',
      reason: 'no_phone',
    });
  });

  it('adds the 9th digit to old-style Brazilian mobile JIDs (no duplicate contact)', () => {
    const old = asMessage(upsert({ conversation: 'oi' }, { remoteJid: '559188887777@s.whatsapp.net' }));
    const current = asMessage(upsert({ conversation: 'oi' }, { remoteJid: '5591988887777@s.whatsapp.net' }));
    expect(old.phone).toBe('5591988887777');
    expect(old.phone).toBe(current.phone);
  });

  it('keeps landlines and foreign numbers untouched', () => {
    expect(normalizeBrazilianMobile('559132221111')).toBe('559132221111'); // fixo
    expect(normalizeBrazilianMobile('351912345678')).toBe('351912345678'); // Portugal
    expect(normalizeBrazilianMobile('14155550123')).toBe('14155550123');
  });

  it('strips the device suffix from a user JID', () => {
    expect(phoneFromJid('5591988887777:12@s.whatsapp.net')).toBe('5591988887777');
    expect(jidKind('x@lid')).toBe('lid');
  });
});

describe('fromMe', () => {
  it('flags messages sent from the phone and drops pushName (it is OUR name)', () => {
    const m = asMessage(upsert({ conversation: 'Já te respondo' }, { fromMe: true }));
    expect(m.fromMe).toBe(true);
    expect(m.contactName).toBe('');
  });
});

describe('timestamps', () => {
  it('accepts numbers, numeric strings, protobuf Longs and milliseconds', () => {
    expect(asMessage(upsert({ conversation: 'a' }, {}, { messageTimestamp: String(TS) })).timestampSeconds).toBe(TS);
    expect(asMessage(upsert({ conversation: 'a' }, {}, { messageTimestamp: { low: TS, high: 0 } })).timestampSeconds).toBe(TS);
    expect(asMessage(upsert({ conversation: 'a' }, {}, { messageTimestamp: TS * 1000 })).timestampSeconds).toBe(TS);
  });
});

describe('envelope and helpers', () => {
  it('normalizes event names from both spellings', () => {
    expect(normalizeEventName('messages.upsert')).toBe('MESSAGES_UPSERT');
    expect(normalizeEventName('MESSAGES_UPDATE')).toBe('MESSAGES_UPDATE');
    expect(normalizeEventName('qrcode.updated')).toBe('QRCODE_UPDATED');
  });

  it('rejects an envelope without an event', () => {
    expect(EnvelopeSchema.safeParse({ data: {} }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ event: 'messages.upsert', data: {} }).success).toBe(true);
  });

  it('rejects an upsert whose key has no id', () => {
    expect(UpsertDataSchema.safeParse({ key: { remoteJid: JID } }).success).toBe(false);
  });

  it('maps delivery statuses to the ones the inbox shows', () => {
    expect(mapEvolutionStatus('SERVER_ACK')).toBe('sent');
    expect(mapEvolutionStatus('DELIVERY_ACK')).toBe('delivered');
    expect(mapEvolutionStatus('READ')).toBe('read');
    expect(mapEvolutionStatus('PLAYED')).toBe('read');
    expect(mapEvolutionStatus('ERROR')).toBe('failed');
    expect(mapEvolutionStatus('PENDING')).toBeNull();
  });
});
