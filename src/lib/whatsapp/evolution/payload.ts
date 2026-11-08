// ============================================================
// Payload do webhook do Evolution → modelo interno.
//
// Dois passos separados de propósito:
//   1. Zod valida o ENVELOPE (forma mínima necessária; o resto é
//      `passthrough`, porque o Evolution muda campos entre versões).
//   2. `convertUpsert` traduz `data` de um `MESSAGES_UPSERT` para um
//      resultado tipado — sem rede, sem banco, 100% testável.
//
// Download de mídia e gravação ficam em `webhook-handler.ts`.
// ============================================================

import { z } from 'zod';

import {
  firstRealPhone,
  jidKind,
  normalizeBrazilianMobile,
  phoneFromJid,
} from './jid';

// ------------------------------------------------------------
// Schemas
// ------------------------------------------------------------

const optionalString = z.string().nullish();

export const KeySchema = z
  .object({
    remoteJid: z.string(),
    fromMe: z.boolean().optional().default(false),
    id: z.string().min(1),
    participant: optionalString,
    // Campos alternativos com o número real quando `remoteJid` é um LID
    // (o nome depende da versão do Evolution/Baileys).
    remoteJidAlt: optionalString,
    participantAlt: optionalString,
    senderPn: optionalString,
  })
  .passthrough();

const TimestampSchema = z.union([
  z.number(),
  z.string(),
  // Long do protobuf serializado: { low, high, unsigned }.
  z.object({ low: z.number() }).passthrough(),
]);

export const UpsertDataSchema = z
  .object({
    key: KeySchema,
    pushName: optionalString,
    message: z.record(z.string(), z.unknown()).nullish(),
    messageType: optionalString,
    messageTimestamp: TimestampSchema.nullish(),
    senderPn: optionalString,
  })
  .passthrough();

export const UpdateDataSchema = z
  .object({
    keyId: optionalString,
    messageId: optionalString,
    key: KeySchema.partial().nullish(),
    remoteJid: optionalString,
    fromMe: z.boolean().nullish(),
    status: z.string(),
  })
  .passthrough();

export const ConnectionDataSchema = z
  .object({
    state: z.string(),
    statusReason: z.number().nullish(),
  })
  .passthrough();

/** Envelope comum a todos os eventos. `data` é validado por evento. */
export const EnvelopeSchema = z
  .object({
    event: z.string().min(1),
    instance: optionalString,
    data: z.unknown(),
  })
  .passthrough();

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type UpsertData = z.infer<typeof UpsertDataSchema>;
export type UpdateData = z.infer<typeof UpdateDataSchema>;

/** `messages.upsert` / `MESSAGES_UPSERT` → `MESSAGES_UPSERT`. */
export function normalizeEventName(event: string): string {
  return event.trim().toUpperCase().replace(/[.\-\s]/g, '_');
}

/** `data` pode vir como objeto ou como lista de objetos. */
export function asList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  return data === undefined || data === null ? [] : [data];
}

// ------------------------------------------------------------
// MESSAGES_UPSERT → resultado tipado
// ------------------------------------------------------------

export type IgnoreReason =
  | 'group'
  | 'status'
  | 'newsletter'
  | 'broadcast'
  | 'unsupported_jid'
  | 'no_phone'
  | 'no_message'
  | 'protocol';

/** Mídia a baixar pelo handler (endpoint de base64 do Evolution). */
export interface MediaRef {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mimetype: string | null;
  fileName: string | null;
}

export interface ConvertedMessage {
  kind: 'message';
  fromMe: boolean;
  /** Dígitos, já na forma canônica brasileira quando aplicável. */
  phone: string;
  /** Nome do remetente (pushName). Vazio em mensagens `fromMe`. */
  contactName: string;
  providerMessageId: string;
  timestampSeconds: number;
  /** Valor para `messages.content_type` (figurinha → `image`). */
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location' | 'interactive';
  /** Tipo cru, para o resumo `[tipo]` quando não há texto. */
  rawType: string;
  contentText: string | null;
  media: MediaRef | null;
  interactiveReplyId: string | null;
  replyToProviderId: string | null;
}

export interface ConvertedReaction {
  kind: 'reaction';
  fromMe: boolean;
  phone: string;
  contactName: string;
  providerMessageId: string;
  timestampSeconds: number;
  targetProviderId: string;
  /** Vazio = reação removida. */
  emoji: string;
}

export type ConvertResult =
  | { kind: 'ignore'; reason: IgnoreReason }
  | ConvertedMessage
  | ConvertedReaction;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** Envelopes que apenas embrulham a mensagem real. */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
] as const;

function unwrap(message: Obj): Obj {
  let current = message;
  for (let depth = 0; depth < 5; depth++) {
    let next: Obj | null = null;
    for (const w of WRAPPERS) {
      const inner = current[w];
      if (isObj(inner) && isObj(inner.message)) {
        next = inner.message;
        break;
      }
    }
    if (!next) return current;
    current = next;
  }
  return current;
}

function timestampSeconds(raw: UpsertData['messageTimestamp']): number {
  let n: number | null = null;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') n = parseInt(raw, 10);
  else if (raw && typeof raw === 'object') n = raw.low;
  if (n === null || !Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  // Alguns servidores mandam milissegundos.
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

/** `stanzaId` do contextInfo de qualquer tipo de mensagem (swipe-reply). */
function replyTarget(content: Obj): string | null {
  for (const value of Object.values(content)) {
    if (isObj(value) && isObj(value.contextInfo)) {
      const id = str(value.contextInfo.stanzaId);
      if (id) return id;
    }
  }
  return null;
}

function locationText(loc: Obj): string {
  const lat = loc.degreesLatitude;
  const lng = loc.degreesLongitude;
  return [str(loc.name), str(loc.address), `${lat},${lng}`].filter(Boolean).join(' - ');
}

function contactText(c: Obj): string {
  const name = str(c.displayName) ?? 'Contato';
  const vcard = str(c.vcard) ?? '';
  const tel = /waid=(\d+)/i.exec(vcard)?.[1] ?? /TEL[^:]*:([+\d\s()-]+)/i.exec(vcard)?.[1]?.trim();
  return tel ? `👤 ${name} — ${tel}` : `👤 ${name}`;
}

/**
 * Resolve o telefone real do contato da conversa. Para `@lid` busca o
 * campo alternativo; devolve null quando só há o LID (a mensagem é
 * descartada em vez de criar contato com um LID no lugar do telefone).
 */
export function resolveChatPhone(data: UpsertData): string | null {
  const { key } = data;
  const kind = jidKind(key.remoteJid);
  let digits: string | null = null;
  if (kind === 'user') {
    digits = phoneFromJid(key.remoteJid);
  } else if (kind === 'lid') {
    digits = firstRealPhone([key.remoteJidAlt, key.senderPn, data.senderPn, key.participantAlt]);
  }
  return digits ? normalizeBrazilianMobile(digits) : null;
}

export function convertUpsert(data: UpsertData): ConvertResult {
  const { key } = data;

  switch (jidKind(key.remoteJid)) {
    case 'group':
      return { kind: 'ignore', reason: 'group' };
    case 'status':
      return { kind: 'ignore', reason: 'status' };
    case 'newsletter':
      return { kind: 'ignore', reason: 'newsletter' };
    case 'broadcast':
      return { kind: 'ignore', reason: 'broadcast' };
    case 'other':
      return { kind: 'ignore', reason: 'unsupported_jid' };
    default:
      break;
  }

  const phone = resolveChatPhone(data);
  if (!phone) return { kind: 'ignore', reason: 'no_phone' };

  if (!data.message || Object.keys(data.message).length === 0) {
    return { kind: 'ignore', reason: 'no_message' };
  }

  const fromMe = key.fromMe === true;
  const contactName = fromMe ? '' : (data.pushName ?? '').trim();
  const ts = timestampSeconds(data.messageTimestamp);
  const content = unwrap(data.message);

  const base = {
    fromMe,
    phone,
    contactName,
    providerMessageId: key.id,
    timestampSeconds: ts,
  };
  const msg = (
    rest: Pick<ConvertedMessage, 'contentType' | 'rawType' | 'contentText' | 'media'> & {
      interactiveReplyId?: string | null;
    }
  ): ConvertedMessage => ({
    kind: 'message',
    ...base,
    interactiveReplyId: null,
    replyToProviderId: replyTarget(content),
    ...rest,
  });

  // --- texto -------------------------------------------------
  if (typeof content.conversation === 'string') {
    return msg({
      contentType: 'text',
      rawType: 'text',
      contentText: content.conversation || null,
      media: null,
    });
  }
  if (isObj(content.extendedTextMessage)) {
    return msg({
      contentType: 'text',
      rawType: 'text',
      contentText: str(content.extendedTextMessage.text),
      media: null,
    });
  }

  // --- mídia -------------------------------------------------
  if (isObj(content.imageMessage)) {
    const m = content.imageMessage;
    return msg({
      contentType: 'image',
      rawType: 'image',
      contentText: str(m.caption),
      media: { kind: 'image', mimetype: str(m.mimetype), fileName: null },
    });
  }
  if (isObj(content.videoMessage)) {
    const m = content.videoMessage;
    return msg({
      contentType: 'video',
      rawType: 'video',
      contentText: str(m.caption),
      media: { kind: 'video', mimetype: str(m.mimetype), fileName: null },
    });
  }
  if (isObj(content.audioMessage)) {
    // Nota de voz (ptt=true) e áudio comum são o mesmo `content_type`.
    return msg({
      contentType: 'audio',
      rawType: content.audioMessage.ptt === true ? 'voice' : 'audio',
      contentText: null,
      media: { kind: 'audio', mimetype: str(content.audioMessage.mimetype), fileName: null },
    });
  }
  if (isObj(content.documentMessage)) {
    const m = content.documentMessage;
    const fileName = str(m.fileName) ?? str(m.title);
    return msg({
      contentType: 'document',
      rawType: 'document',
      contentText: str(m.caption) ?? fileName,
      media: { kind: 'document', mimetype: str(m.mimetype), fileName },
    });
  }
  if (isObj(content.stickerMessage)) {
    // Figurinha é imagem para o inbox (o CHECK não tem 'sticker').
    return msg({
      contentType: 'image',
      rawType: 'sticker',
      contentText: null,
      media: { kind: 'sticker', mimetype: str(content.stickerMessage.mimetype), fileName: null },
    });
  }

  // --- localização / contato --------------------------------
  if (isObj(content.locationMessage) || isObj(content.liveLocationMessage)) {
    const loc = (content.locationMessage ?? content.liveLocationMessage) as Obj;
    return msg({
      contentType: 'location',
      rawType: 'location',
      contentText: locationText(loc),
      media: null,
    });
  }
  if (isObj(content.contactMessage)) {
    return msg({
      contentType: 'text',
      rawType: 'contact',
      contentText: contactText(content.contactMessage),
      media: null,
    });
  }
  if (isObj(content.contactsArrayMessage) && Array.isArray(content.contactsArrayMessage.contacts)) {
    const lines = content.contactsArrayMessage.contacts.filter(isObj).map(contactText);
    return msg({
      contentType: 'text',
      rawType: 'contact',
      contentText: lines.join('\n') || null,
      media: null,
    });
  }

  // --- reação -----------------------------------------------
  if (isObj(content.reactionMessage)) {
    const r = content.reactionMessage;
    const target = isObj(r.key) ? str(r.key.id) : null;
    if (!target) return { kind: 'ignore', reason: 'no_message' };
    return {
      kind: 'reaction',
      ...base,
      targetProviderId: target,
      emoji: typeof r.text === 'string' ? r.text : '',
    };
  }

  // --- toque em botão / lista (mensagens interativas nativas) ---
  if (isObj(content.buttonsResponseMessage)) {
    const r = content.buttonsResponseMessage;
    const id = str(r.selectedButtonId);
    return msg({
      contentType: 'interactive',
      rawType: 'interactive',
      contentText: str(r.selectedDisplayText) ?? id,
      media: null,
      interactiveReplyId: id,
    });
  }
  if (isObj(content.listResponseMessage)) {
    const r = content.listResponseMessage;
    const id = isObj(r.singleSelectReply) ? str(r.singleSelectReply.selectedRowId) : null;
    return msg({
      contentType: 'interactive',
      rawType: 'interactive',
      contentText: str(r.title) ?? id,
      media: null,
      interactiveReplyId: id,
    });
  }
  if (isObj(content.templateButtonReplyMessage)) {
    const r = content.templateButtonReplyMessage;
    const id = str(r.selectedId);
    return msg({
      contentType: 'interactive',
      rawType: 'interactive',
      contentText: str(r.selectedDisplayText) ?? id,
      media: null,
      interactiveReplyId: id,
    });
  }

  // --- mensagens de protocolo/sistema: não são conversa ----------
  const keys = Object.keys(content);
  if (
    keys.every((k) =>
      ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'albumMessage'].includes(k)
    )
  ) {
    return { kind: 'ignore', reason: 'protocol' };
  }

  // --- qualquer outra coisa: nunca quebrar ---------------------
  return msg({
    contentType: 'text',
    rawType: keys[0] ?? 'unknown',
    contentText: '[tipo não suportado]',
    media: null,
  });
}

// ------------------------------------------------------------
// MESSAGES_UPDATE → status interno
// ------------------------------------------------------------

/**
 * Status do Baileys/Evolution → vocabulário de `messages.status`.
 * `PENDING` e desconhecidos viram null (não há o que atualizar).
 */
export function mapEvolutionStatus(
  raw: string
): 'sent' | 'delivered' | 'read' | 'failed' | null {
  switch (raw.toUpperCase()) {
    case 'SERVER_ACK':
    case 'SENT':
      return 'sent';
    case 'DELIVERY_ACK':
    case 'DELIVERED':
      return 'delivered';
    case 'READ':
    case 'PLAYED':
      return 'read';
    case 'ERROR':
    case 'FAILED':
      return 'failed';
    default:
      return null;
  }
}
