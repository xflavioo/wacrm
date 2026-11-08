// ============================================================
// Disparo (broadcast) de mensagem LIVRE no canal QR code.
//
// Na Meta um disparo é sempre um template aprovado. No canal Evolution
// não existe template: o disparo é texto (e, opcionalmente, uma mídia
// com o texto de legenda), enviado um a um pelo provedor — que já aplica
// a fila antibanimento (intervalo mínimo + atraso aleatório) antes de
// cada envio. Este módulo valida o pedido e envia o lote.
// ============================================================

import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import type { WhatsAppProvider } from '@/lib/whatsapp/provider/types';

export const FREE_MEDIA_KINDS = ['image', 'video', 'document'] as const;
export type FreeMediaKind = (typeof FREE_MEDIA_KINDS)[number];

export interface FreeMessage {
  text: string;
  mediaUrl?: string | null;
  mediaKind?: FreeMediaKind | null;
}

export interface FreeRecipient {
  phone: string;
  /** Texto já personalizado para este destinatário; vence `free.text`. */
  text?: string;
}

export interface FreeSendResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** Limite do WhatsApp para texto; legenda de mídia é menor. */
export const FREE_TEXT_MAX = 4096;
export const FREE_CAPTION_MAX = 1024;
/** Máximo de destinatários por requisição (o cliente envia em lotes pequenos). */
export const FREE_BATCH_MAX = 10;

export class FreeBroadcastError extends Error {
  readonly status = 400 as const;
}

/** Valida a mensagem livre. Lança `FreeBroadcastError` com texto em pt-BR. */
export function validateFreeMessage(raw: unknown): FreeMessage {
  if (!raw || typeof raw !== 'object') {
    throw new FreeBroadcastError('Informe a mensagem do disparo.');
  }
  const m = raw as Record<string, unknown>;
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const mediaUrl = typeof m.mediaUrl === 'string' ? m.mediaUrl.trim() : '';
  const mediaKind = typeof m.mediaKind === 'string' ? m.mediaKind : '';

  if (!text && !mediaUrl) {
    throw new FreeBroadcastError('Escreva o texto do disparo (ou informe uma mídia).');
  }
  if (!mediaUrl && text.length > FREE_TEXT_MAX) {
    throw new FreeBroadcastError(`O texto passa de ${FREE_TEXT_MAX} caracteres.`);
  }
  if (mediaUrl) {
    let url: URL;
    try {
      url = new URL(mediaUrl);
    } catch {
      throw new FreeBroadcastError('A URL da mídia é inválida.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new FreeBroadcastError('A URL da mídia precisa começar com http:// ou https://.');
    }
    if (!(FREE_MEDIA_KINDS as readonly string[]).includes(mediaKind)) {
      throw new FreeBroadcastError('Escolha o tipo da mídia: imagem, vídeo ou documento.');
    }
    if (text.length > FREE_CAPTION_MAX) {
      throw new FreeBroadcastError(`A legenda passa de ${FREE_CAPTION_MAX} caracteres.`);
    }
  }
  return {
    text,
    mediaUrl: mediaUrl || null,
    mediaKind: (mediaUrl ? mediaKind : null) as FreeMediaKind | null,
  };
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last).slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Envia o lote, um destinatário por vez. A falha de um nunca aborta os
 * outros: o resultado de cada telefone volta no array (mesmo contrato do
 * disparo por template).
 */
export async function sendFreeBroadcastBatch(
  provider: WhatsAppProvider,
  recipients: FreeRecipient[],
  free: FreeMessage
): Promise<FreeSendResult[]> {
  const results: FreeSendResult[] = [];

  for (const r of recipients) {
    const phone = sanitizePhoneForMeta(r.phone ?? '');
    if (!isValidE164(phone)) {
      results.push({ phone: r.phone, status: 'failed', error: 'Número de telefone inválido.' });
      continue;
    }
    const text = (r.text ?? free.text).trim();
    try {
      const sent =
        free.mediaUrl && free.mediaKind
          ? await provider.sendMedia({
              to: phone,
              kind: free.mediaKind,
              link: free.mediaUrl,
              caption: text || undefined,
              filename:
                free.mediaKind === 'document' ? fileNameFromUrl(free.mediaUrl) : undefined,
            })
          : await provider.sendText({ to: phone, text });
      results.push({ phone: r.phone, status: 'sent', whatsapp_message_id: sent.messageId });
    } catch (err) {
      results.push({
        phone: r.phone,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Erro desconhecido ao enviar.',
      });
    }
  }

  return results;
}
