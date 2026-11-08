// ============================================================
// Pipeline de mensagem RECEBIDA — compartilhado entre provedores.
//
// Extraído de `src/app/api/whatsapp/webhook/route.ts` (webhook da Meta)
// SEM mudar o comportamento: o corpo das funções é o que estava lá, só
// que recebendo o cliente do Supabase (`db`) em vez de criar um próprio.
// O webhook do Evolution (`src/lib/whatsapp/evolution/webhook-handler.ts`)
// chama as MESMAS funções, então contato, conversa, gravação idempotente,
// contagem de não lidas, fluxos, automações, IA e webhooks públicos
// se comportam igual nos dois canais.
//
// O que é específico de provedor fica fora daqui: validar a assinatura,
// achar a conta, interpretar o payload e baixar mídia.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

/** Quem é o dono da conversa: tenancy + usuário de auditoria. */
export interface InboundContext {
  db: SupabaseClient
  /** Tenancy — todo contato/conversa/mensagem criado leva este id. */
  accountId: string
  /**
   * Usuário de auditoria para colunas `user_id NOT NULL`. Sempre o admin
   * que salvou a config do WhatsApp; a escolha é arbitrária pós-017, mas
   * estável.
   */
  configOwnerUserId: string
}

export interface ContactOutcome {
  contact: Row
  /** True quando esta chamada criou a linha; dispara `new_contact_created`. */
  wasCreated: boolean
}

export interface InboundThread {
  contact: ContactOutcome
  conversation: Row
  conversationCreated: boolean
}

// ------------------------------------------------------------
// Contato e conversa
// ------------------------------------------------------------

export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string
): Promise<{ conversation: Row; created: boolean } | null> {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Acha/cria contato e conversa para um telefone e, se a conversa é nova,
 * emite `conversation.created` — antes de qualquer mensagem, para um
 * assinante sempre ver a conversa abrir antes do primeiro
 * `message.received` (e mesmo quando a primeira coisa é uma reação).
 */
export async function resolveInboundThread(
  ctx: InboundContext,
  phone: string,
  name: string
): Promise<InboundThread | null> {
  const { db, accountId, configOwnerUserId } = ctx

  const contact = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    phone,
    name
  )
  if (!contact) return null

  const convResult = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    contact.contact.id
  )
  if (!convResult) return null

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: convResult.conversation.id,
      contact_id: contact.contact.id,
    })
  }

  return {
    contact,
    conversation: convResult.conversation,
    conversationCreated: convResult.created,
  }
}

// ------------------------------------------------------------
// Reações
// ------------------------------------------------------------

/**
 * Resolve um id de mensagem do provedor no UUID interno, dentro de uma
 * conversa. Null quando nunca recebemos o pai (ex.: resposta a uma
 * mensagem anterior à instalação do CRM).
 */
export async function lookupInternalIdByProviderId(
  db: SupabaseClient,
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200.
 */
export async function applyInboundReaction(
  db: SupabaseClient,
  args: {
    conversationId: string
    contactId: string
    /** Id (do provedor) da mensagem reagida. */
    targetProviderId: string
    /** Vazio = remoção (spec da Cloud API; o Evolution manda igual). */
    emoji: string
  }
): Promise<void> {
  const { conversationId, contactId, targetProviderId, emoji } = args
  if (!targetProviderId) return

  const targetInternalId = await lookupInternalIdByProviderId(
    db,
    targetProviderId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      targetProviderId
    )
    return
  }

  // Empty emoji = removal.
  if (!emoji) {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await db.from('message_reactions').upsert(
    {
      message_id: targetInternalId,
      conversation_id: conversationId,
      actor_type: 'customer',
      actor_id: contactId,
      emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' }
  )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

// ------------------------------------------------------------
// Resposta de broadcast
// ------------------------------------------------------------

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string
) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

// ------------------------------------------------------------
// Mensagem recebida
// ------------------------------------------------------------

/** O que o webhook de cada provedor entrega depois de interpretar o payload. */
export interface NormalizedInboundMessage {
  /** Id da mensagem no provedor (`wamid...` / `key.id`). Chave de idempotência. */
  providerMessageId: string
  /** Tipo cru do provedor, só para o resumo `[tipo]` quando não há texto. */
  rawType: string
  /** Já mapeado para o CHECK de `messages.content_type`. */
  contentType: string
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /** Id do botão/linha tocado; dirige o runner de fluxos. */
  interactiveReplyId: string | null
  /** Id (do provedor) da mensagem citada num swipe-reply. */
  replyToProviderId: string | null
  /** Epoch em SEGUNDOS — vira `messages.created_at`. */
  timestampSeconds: number
  /** Texto usado por fluxos/automações quando `contentText` é nulo. */
  fallbackText?: string
}

/**
 * Grava a mensagem do cliente e dispara tudo que depende dela.
 *
 * A ordem é a do webhook original e é load-bearing: o INSERT idempotente
 * vem ANTES do bump de não lidas e de todo o fan-out (issue #367).
 */
export async function persistAndDispatchInbound(
  ctx: InboundContext,
  thread: InboundThread,
  message: NormalizedInboundMessage
): Promise<void> {
  const { db, accountId, configOwnerUserId } = ctx
  const conversation = thread.conversation
  const contactRecord = thread.contact.contact

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.replyToProviderId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      db,
      message.replyToProviderId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.replyToProviderId
      )
    }
  }

  const { contentText, contentType, interactiveReplyId } = message

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert. Providers retry webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert — an empty result means this delivery
  // was a replay. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: message.mediaUrl,
        // MIME type of the attachment (migration 039). Was discarded
        // before, which forced the download path to guess an extension
        // from the fetched blob — impossible to do until the bytes had
        // already been fetched successfully.
        media_type: message.mediaType,
        message_id: message.providerMessageId,
        status: 'delivered',
        created_at: new Date(message.timestampSeconds * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'. Migration 010 added
        // the column; null for every other content_type so existing inserts
        // behave identically.
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      message.providerMessageId
    )
    return
  }

  // Update conversation. The unread bump is done DB-side (migration 037's
  // bump_conversation_on_inbound) rather than as a read-modify-write of the
  // snapshot loaded above: two inbound messages for the same conversation
  // can process concurrently, and computing `snapshot + 1` in the app let
  // both reads see the same value and write the same increment, losing one
  // (issue #369). The RPC increments in a single UPDATE and refreshes the
  // last-message summary in the same statement.
  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || `[${message.rawType}]`,
  })

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate conditional statement rather than a `status` field on the
  // update above so the write can be gated on the row's CURRENT status in
  // SQL — see the helper for why that matters.
  await reopenClosedConversation(db, conversation)

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(db, accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.providerMessageId,
        }
      : {
          kind: 'text',
          text: contentText ?? message.fallbackText ?? '',
          meta_message_id: message.providerMessageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  const inboundText = contentText ?? message.fallbackText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (thread.contact.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run. That is issue #301's failure mode
  // recurring one level down, and it's what issue #409 reported as runs
  // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.providerMessageId,
    content_type: contentType,
    text: contentText,
  })
}

// ------------------------------------------------------------
// Mensagem enviada pelo próprio celular (canal QR)
// ------------------------------------------------------------

/**
 * Mensagem que a PRÓPRIA conta mandou pelo celular (`fromMe`). Grava como
 * enviada na conversa certa e atualiza a prévia — e nada mais: sem
 * não lidas, sem fluxos, sem automações, sem IA, sem `message.received`.
 * Quem escreveu foi um humano; reagir a isso seria o bot falando sozinho.
 *
 * Idempotente pelo mesmo índice único (conversation_id, message_id) da
 * 037: quando o envio partiu do próprio wacrm, a linha já existe e este
 * upsert não faz nada.
 *
 * @returns true se gravou uma linha nova.
 */
export async function persistOutboundFromPhone(
  ctx: InboundContext,
  thread: InboundThread,
  message: NormalizedInboundMessage
): Promise<boolean> {
  const { db } = ctx
  const conversation = thread.conversation

  let replyToInternalId: string | null = null
  if (message.replyToProviderId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      db,
      message.replyToProviderId,
      conversation.id
    )
  }

  const { data: insertedRows, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: message.contentType,
        content_text: message.contentText,
        media_url: message.mediaUrl,
        media_type: message.mediaType,
        message_id: message.providerMessageId,
        status: 'sent',
        created_at: new Date(message.timestampSeconds * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (error) {
    console.error('Error inserting message sent from phone:', error)
    return false
  }
  if (!insertedRows || insertedRows.length === 0) return false

  await db
    .from('conversations')
    .update({
      last_message_text: message.contentText || `[${message.rawType}]`,
      last_message_at: new Date(message.timestampSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  return true
}
