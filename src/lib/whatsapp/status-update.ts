// ============================================================
// Atualizacao de status de entrega do canal QR (Evolution).
//
// O webhook da Meta usa `applyMessageStatus` +
// `applyBroadcastRecipientStatus` diretamente (route.ts). O Evolution usa
// as MESMAS funcoes, com uma diferenca: ele manda `key.id`s curtos que
// podem repetir entre contas, entao toda leitura/escrita e restrita a
// conta dona do canal. `applyMessageStatus` ja e escopado por conta; o
// espelho em `broadcast_recipients` ganha aqui uma checagem de posse
// antes de chamar a funcao (que casa so pelo id da mensagem).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { applyBroadcastRecipientStatus } from '@/lib/whatsapp/broadcast-recipient-webhook'
import { applyMessageStatus } from '@/lib/whatsapp/message-status-sync'

export interface StatusUpdate {
  /** Id da mensagem no provedor (`key.id`). */
  id: string
  /** Ja no vocabulario de `messages.status`: sent | delivered | read | failed. */
  status: string
  /** Epoch em segundos, como string ou numero. */
  timestamp: string | number
}

export async function applyStatusUpdate(
  db: SupabaseClient,
  status: StatusUpdate,
  /** Conta dona do canal: toda leitura e escrita fica restrita a ela. */
  accountId: string
): Promise<void> {
  const tsSeconds =
    typeof status.timestamp === 'number'
      ? status.timestamp
      : parseInt(status.timestamp)
  const occurredAt = Number.isFinite(tsSeconds)
    ? new Date(tsSeconds * 1000).toISOString()
    : new Date().toISOString()

  // 1) Mensagens da conversa (escopado por conta pela propria funcao).
  const advanced = await applyMessageStatus(db, accountId, {
    wamid: status.id,
    status: status.status,
    failure: null,
    statusAt: occurredAt,
  })

  // 2) Destinatario de disparo — so se o disparo e DESTA conta.
  const { data: owned } = await db
    .from('broadcast_recipients')
    .select('id, broadcasts!inner(account_id)')
    .eq('whatsapp_message_id', status.id)
    .eq('broadcasts.account_id', accountId)
    .limit(1)
  if (owned && owned.length > 0) {
    await applyBroadcastRecipientStatus(db, {
      whatsappMessageId: status.id,
      status: status.status,
      occurredAt,
      failure: null,
    })
  }

  // 3) Webhook publico `message.status_updated`, por ultimo para um
  //    assinante lento nao atrasar os espelhos acima.
  for (const message of advanced) {
    await dispatchWebhookEvent(db, accountId, 'message.status_updated', {
      whatsapp_message_id: status.id,
      conversation_id: message.conversation_id,
      status: status.status,
    })
  }
}
