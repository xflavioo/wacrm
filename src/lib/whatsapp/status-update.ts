// ============================================================
// Atualização de status de entrega (enviada → entregue → lida).
//
// Extraído de `src/app/api/whatsapp/webhook/route.ts` sem mudar o
// comportamento da Meta; o webhook do Evolution usa a mesma função.
//
// Diferença única: `accountId`. A Meta identifica a mensagem por um
// `wamid` globalmente único e a rota original nunca filtrou por conta,
// então sem `accountId` o comportamento é exatamente o antigo. O
// Evolution manda `key.id`s curtos que podem repetir entre contas; com
// `accountId` toda leitura/escrita é restrita à conta dona do canal.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once the provider
// has delivered or the user has read or replied, a later "failed" status
// event is a bug in the provider's pipeline or a spoof attempt and must
// be ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
export function isValidStatusTransition(
  current: string,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

export interface StatusUpdate {
  /** Id da mensagem no provedor (`wamid...` / `key.id`). */
  id: string
  /** Já no vocabulário de `messages.status`: sent | delivered | read | failed. */
  status: string
  /** Epoch em segundos, como string (formato da Meta) ou número. */
  timestamp: string | number
}

export async function applyStatusUpdate(
  db: SupabaseClient,
  status: StatusUpdate,
  /** Restringe a uma conta. Omitido = comportamento histórico da Meta. */
  accountId?: string
): Promise<void> {
  const tsSeconds =
    typeof status.timestamp === 'number'
      ? status.timestamp
      : parseInt(status.timestamp)
  const tsIso = new Date(tsSeconds * 1000).toISOString()

  // 1) Mirror onto messages (legacy behavior) — the provider's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()` on the unscoped path: message_id is NOT unique
  //    (migration 009 — ids repeat across numbers), so this updates 0..N rows
  //    and must not assume a single row.
  if (accountId) {
    // Escopo por conta: resolve primeiro os ids internos das mensagens
    // DESTA conta e só então atualiza.
    const { data: owned } = await db
      .from('messages')
      .select('id, status, conversations!inner(account_id)')
      .eq('message_id', status.id)
      .eq('conversations.account_id', accountId)
    const ids = ((owned ?? []) as { id: string; status: string }[])
      .filter((m) => m.status !== status.status)
      .filter((m) => isValidStatusTransition(m.status, status.status))
      .map((m) => m.id)
    if (ids.length > 0) {
      const { error: scopedErr } = await db
        .from('messages')
        .update({ status: status.status })
        .in('id', ids)
      if (scopedErr) console.error('Error updating message status:', scopedErr)
    }
  } else {
    const { error: msgErr } = await db
      .from('messages')
      .update({ status: status.status })
      .eq('message_id', status.id)

    if (msgErr) {
      console.error('Error updating message status:', msgErr)
    }
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const recipientQuery = accountId
    ? db
        .from('broadcast_recipients')
        .select('id, status, broadcasts!inner(account_id)')
        .eq('whatsapp_message_id', status.id)
        .eq('broadcasts.account_id', accountId)
    : db
        .from('broadcast_recipients')
        .select('id, status')
        .eq('whatsapp_message_id', status.id)
  const { data: recipient, error: recFetchErr } =
    await recipientQuery.maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await db
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const msgRowQuery = db
    .from('messages')
    .select(
      accountId
        ? 'conversation_id, conversations!inner(account_id)'
        : 'conversation_id, conversations(account_id)'
    )
    .eq('message_id', status.id)
  const { data: msgRow } = await (accountId
    ? msgRowQuery.eq('conversations.account_id', accountId)
    : msgRowQuery
  )
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const row = msgRow as unknown as {
      conversation_id: string
      conversations: { account_id: string } | null
    }
    const owner = row.conversations?.account_id
    if (owner) {
      await dispatchWebhookEvent(db, owner, 'message.status_updated', {
        whatsapp_message_id: status.id,
        conversation_id: row.conversation_id,
        status: status.status,
      })
    }
  }
}
