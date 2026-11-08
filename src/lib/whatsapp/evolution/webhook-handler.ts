// ============================================================
// Processamento dos eventos do webhook do Evolution.
//
// A rota (`/api/evolution/webhook/[secret]`) autentica, valida o
// envelope e responde 200; o trabalho pesado roda aqui, dentro do
// `after()` — o mesmo padrão do webhook da Meta. Nada aqui lança para
// fora: um evento ruim não pode derrubar os demais do lote.
//
// Gravação, fluxos, automações, IA e webhooks públicos vêm de
// `@/lib/whatsapp/inbound` — as MESMAS funções do webhook da Meta.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  applyInboundReaction,
  persistAndDispatchInbound,
  persistOutboundFromPhone,
  phoneIdentity,
  resolveInboundThread,
  type InboundContext,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound';
import {
  mirrorInboundMedia,
  normalizeMimeType,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media';
import { applyStatusUpdate } from '@/lib/whatsapp/status-update';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

import { fetchConnectedNumber, getMediaBase64, normalizeState } from './client';
import {
  evolutionCredsFromRow,
  stateToStatus,
  type EvolutionConfigRow,
} from './config';
import { matchNumberedReply, optionsFromPayload } from './interactive-text';
import {
  ConnectionDataSchema,
  UpdateDataSchema,
  UpsertDataSchema,
  asList,
  convertUpsert,
  mapEvolutionStatus,
  normalizeEventName,
  type ConvertedMessage,
  type Envelope,
} from './payload';

/**
 * Quanto esperar antes de tratar uma mensagem `fromMe`. Quando o envio
 * partiu do wacrm, o Evolution devolve o eco `fromMe` quase junto com a
 * resposta HTTP — antes de o wacrm gravar a linha. Esperar um instante
 * deixa o envio gravar primeiro; o eco então é reconhecido pelo id e
 * ignorado (e o INSERT do wacrm não esbarra no índice único da 037).
 */
export const OUTBOUND_ECHO_DELAY_MS = 2500;

export interface HandlerDeps {
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Entrada única: despacha o evento para o tratador certo. Nunca lança. */
export async function processEvolutionEvent(
  db: SupabaseClient,
  row: EvolutionConfigRow,
  envelope: Envelope,
  deps: HandlerDeps = {}
): Promise<void> {
  const event = normalizeEventName(envelope.event);
  try {
    switch (event) {
      case 'MESSAGES_UPSERT':
        for (const item of asList(envelope.data)) {
          await handleUpsert(db, row, item, deps);
        }
        break;
      case 'MESSAGES_UPDATE':
        for (const item of asList(envelope.data)) {
          await handleUpdate(db, row, item);
        }
        break;
      case 'CONNECTION_UPDATE':
        await handleConnection(db, row, envelope.data);
        break;
      case 'QRCODE_UPDATED':
        await handleQrUpdated(db, row);
        break;
      default:
        // Evento que não consumimos (presence, chats.*, contacts.*…).
        break;
    }
  } catch (err) {
    console.error(
      `[evolution] failed to process ${event}:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ------------------------------------------------------------
// MESSAGES_UPSERT
// ------------------------------------------------------------

async function messageExists(
  db: SupabaseClient,
  accountId: string,
  providerMessageId: string
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', providerMessageId)
    .eq('conversations.account_id', accountId)
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

async function handleUpsert(
  db: SupabaseClient,
  row: EvolutionConfigRow,
  raw: unknown,
  deps: HandlerDeps
): Promise<void> {
  const parsed = UpsertDataSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[evolution] ignoring malformed MESSAGES_UPSERT item');
    return;
  }

  const converted = convertUpsert(parsed.data);
  if (converted.kind === 'ignore') return;

  const ctx: InboundContext = {
    db,
    accountId: row.account_id,
    configOwnerUserId: row.user_id,
  };

  // ---- mensagem que EU mandei (pelo celular ou pelo próprio wacrm) ----
  if (converted.fromMe) {
    // Reação enviada por nós: não é conteúdo de conversa.
    if (converted.kind === 'reaction') return;

    await (deps.sleep ?? defaultSleep)(OUTBOUND_ECHO_DELAY_MS);
    // Eco de um envio do wacrm (ou replay): já está gravado.
    if (await messageExists(db, row.account_id, converted.providerMessageId)) return;

    const thread = await resolveInboundThread(ctx, phoneIdentity(converted.phone, ''));
    if (!thread) return;

    const media = await resolveMedia(db, row, converted);
    await persistOutboundFromPhone(
      ctx,
      thread,
      toNormalized(converted, media, null)
    );
    return;
  }

  // ---- mensagem do cliente ----
  if (converted.kind === 'reaction') {
    const thread = await resolveInboundThread(ctx, phoneIdentity(converted.phone, converted.contactName));
    if (!thread) return;
    await applyInboundReaction(db, {
      conversationId: thread.conversation.id,
      contactId: thread.contact.contact.id,
      targetProviderId: converted.targetProviderId,
      emoji: converted.emoji,
    });
    return;
  }

  // Replay do Evolution: não baixa mídia de novo nem recria nada.
  if (await messageExists(db, row.account_id, converted.providerMessageId)) {
    console.info('[evolution] duplicate inbound message ignored:', converted.providerMessageId);
    return;
  }

  const thread = await resolveInboundThread(ctx, phoneIdentity(converted.phone, converted.contactName));
  if (!thread) return;

  const media = await resolveMedia(db, row, converted);

  // "Responda 1, 2 ou 3": o texto do cliente volta a ser um toque de botão.
  const numbered =
    converted.contentType === 'text' && !converted.interactiveReplyId
      ? await resolveNumberedReply(db, thread.conversation.id, converted.contentText)
      : null;

  await persistAndDispatchInbound(
    ctx,
    thread,
    toNormalized(converted, media, numbered)
  );
}

interface ResolvedMedia {
  mediaUrl: string | null;
  mediaType: string | null;
}

function toNormalized(
  m: ConvertedMessage,
  media: ResolvedMedia | null,
  numbered: { id: string; title: string } | null
): NormalizedInboundMessage {
  const caption = m.contentText;
  // Mídia que não pôde ser guardada não pode virar um balão em branco.
  const contentText =
    numbered?.title ??
    (m.media && !media?.mediaUrl && !caption ? '[mídia indisponível]' : caption);
  return {
    providerMessageId: m.providerMessageId,
    rawType: m.rawType,
    contentType: numbered ? 'interactive' : m.contentType,
    contentText,
    mediaUrl: media?.mediaUrl ?? null,
    mediaType: media?.mediaType ?? null,
    interactiveReplyId: numbered?.id ?? m.interactiveReplyId,
    replyToProviderId: m.replyToProviderId,
    timestampSeconds: m.timestampSeconds,
    fallbackText: contentText ?? '',
  };
}

/**
 * Baixa a mídia pelo endpoint de base64 do Evolution e a guarda no
 * bucket `chat-media` pelo MESMO caminho da Meta (`mirrorInboundMedia`,
 * com o download injetado). Diferente da Meta, não existe URL "proxy"
 * de reserva, então o espelhamento ignora a opção
 * `mirror_inbound_media`: sem a cópia a mídia simplesmente não existe.
 * Best-effort — qualquer falha devolve URL nula.
 */
async function resolveMedia(
  db: SupabaseClient,
  row: EvolutionConfigRow,
  m: ConvertedMessage
): Promise<ResolvedMedia | null> {
  if (!m.media) return null;
  try {
    const creds = evolutionCredsFromRow(row);
    const downloaded = await getMediaBase64(creds, { messageId: m.providerMessageId });
    const buffer = Buffer.from(downloaded.base64, 'base64');
    const mime = m.media.mimetype ?? downloaded.mimetype;
    const url = await mirrorInboundMedia({
      storage: db.storage as unknown as MirrorStorage,
      accountId: row.account_id,
      mediaId: m.providerMessageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'media',
      downloadUrl: 'evolution://media',
      accessToken: '',
      mimeType: mime,
      fileName: m.media.fileName ?? downloaded.fileName,
      messageTimestamp: m.timestampSeconds,
      download: async () => ({
        buffer,
        contentType: mime ?? 'application/octet-stream',
      }),
    });
    return { mediaUrl: url, mediaType: normalizeMimeType(mime) };
  } catch (err) {
    console.warn(
      '[evolution] could not fetch media:',
      err instanceof Error ? err.message : err
    );
    return { mediaUrl: null, mediaType: m.media.mimetype };
  }
}

/** A última mensagem da conversa é numerada e o cliente respondeu com uma opção? */
async function resolveNumberedReply(
  db: SupabaseClient,
  conversationId: string,
  text: string | null
): Promise<{ id: string; title: string } | null> {
  if (!text) return null;
  const { data } = await db
    .from('messages')
    .select('sender_type, content_type, interactive_payload')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1);
  const last = Array.isArray(data) ? data[0] : null;
  if (
    !last ||
    last.sender_type === 'customer' ||
    last.content_type !== 'interactive' ||
    !last.interactive_payload
  ) {
    return null;
  }
  return matchNumberedReply(
    optionsFromPayload(last.interactive_payload as InteractiveMessagePayload),
    text
  );
}

// ------------------------------------------------------------
// MESSAGES_UPDATE
// ------------------------------------------------------------

async function handleUpdate(
  db: SupabaseClient,
  row: EvolutionConfigRow,
  raw: unknown
): Promise<void> {
  const parsed = UpdateDataSchema.safeParse(raw);
  if (!parsed.success) return;
  const u = parsed.data;

  // Recibo de uma mensagem do CLIENTE (nós lemos): não há o que espelhar.
  if (u.fromMe === false || u.key?.fromMe === false) return;

  const id = u.keyId ?? u.key?.id ?? u.messageId;
  const status = mapEvolutionStatus(u.status);
  if (!id || !status) return;

  await applyStatusUpdate(
    db,
    { id, status, timestamp: Math.floor(Date.now() / 1000) },
    row.account_id
  );
}

// ------------------------------------------------------------
// CONNECTION_UPDATE / QRCODE_UPDATED
// ------------------------------------------------------------

async function handleConnection(
  db: SupabaseClient,
  row: EvolutionConfigRow,
  raw: unknown
): Promise<void> {
  const parsed = ConnectionDataSchema.safeParse(
    Array.isArray(raw) ? raw[0] : raw
  );
  if (!parsed.success) return;

  const next = stateToStatus(normalizeState(parsed.data.state));
  const wasConnected = row.status === 'connected';
  // "connecting" depois de já ter conectado é o Baileys tentando voltar.
  const wasRecentlyConnected =
    wasConnected || (row.status === 'connecting' && Boolean(row.connected_at));

  const update: Record<string, unknown> = {
    status: next,
    updated_at: new Date().toISOString(),
  };

  if (next === 'connected') {
    if (!wasConnected) update.connected_at = new Date().toISOString();
    try {
      const phone = await fetchConnectedNumber(evolutionCredsFromRow(row));
      if (phone) update.evolution_phone = phone;
    } catch {
      // Sem o número a conexão continua válida; a tela mostra o que tiver.
    }
  } else if (next === 'disconnected') {
    update.connected_at = null;
    update.evolution_phone = null;
  }

  if (next === row.status && next !== 'connected') return;

  await db.from('whatsapp_config').update(update).eq('id', row.id);

  if (next === 'disconnected' && wasRecentlyConnected) {
    await notifyDisconnected(db, row.account_id);
  }
}

async function handleQrUpdated(
  db: SupabaseClient,
  row: EvolutionConfigRow
): Promise<void> {
  // O QR em si nunca é gravado (decisão D9): a tela busca um novo direto
  // no Evolution. O evento só confirma que a instância está aguardando.
  if (row.status === 'disconnected') {
    await db
      .from('whatsapp_config')
      .update({ status: 'connecting', updated_at: new Date().toISOString() })
      .eq('id', row.id);
  }
}

/**
 * Avisa owners e admins que o WhatsApp caiu. Sem duplicar: não cria outra
 * notificação não lida do mesmo tipo nos últimos 10 minutos.
 */
async function notifyDisconnected(
  db: SupabaseClient,
  accountId: string
): Promise<void> {
  const { data: admins } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin']);
  if (!admins || admins.length === 0) return;

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const rows: Record<string, unknown>[] = [];
  for (const a of admins as { user_id: string }[]) {
    const { data: recent } = await db
      .from('notifications')
      .select('id')
      .eq('user_id', a.user_id)
      .eq('type', 'whatsapp_disconnected')
      .is('read_at', null)
      .gte('created_at', since)
      .limit(1);
    if (recent && recent.length > 0) continue;
    rows.push({
      account_id: accountId,
      user_id: a.user_id,
      type: 'whatsapp_disconnected',
      title: 'WhatsApp desconectado',
      body: 'A conexão por QR code caiu. Abra Configurações → WhatsApp e leia o QR code novamente para voltar a enviar e receber mensagens.',
    });
  }
  if (rows.length === 0) return;

  const { error } = await db.from('notifications').insert(rows);
  if (error) {
    console.error('[evolution] failed to create disconnect notifications:', error.message);
  }
}
