// ============================================================
// Provedor Evolution (QR code) — implementa `WhatsAppProvider`.
//
// Adaptador fino sobre `client.ts`. O que ele acrescenta:
//   * ritmo antibanimento (`throttle`) antes de cada envio;
//   * "digitando…" proporcional ao tamanho do texto (parâmetro `delay`);
//   * mensagens interativas viram TEXTO NUMERADO — botões e listas não
//     são confiáveis no WhatsApp não oficial (ver interactive-text.ts);
//   * modelos (templates) são recusados com uma mensagem clara: só
//     existem na API oficial da Meta;
//   * sem retry de variante de telefone: isso é política do sandbox da
//     Meta (erro 131030) e, aqui, escreveria de volta em
//     `contacts.phone` uma variante fabricada.
// ============================================================

import {
  EvolutionError,
  markAsRead,
  sendAudio,
  sendMedia,
  sendPresence,
  sendReaction,
  sendText,
  type EvolutionCreds,
} from './client';
import {
  descriptionsFromSections,
  optionsFromButtons,
  optionsFromSections,
  renderNumberedText,
} from './interactive-text';
import type { Throttle } from './throttle';
import type {
  ProviderSendAudioArgs,
  ProviderSendInteractiveButtonsArgs,
  ProviderSendInteractiveListArgs,
  ProviderSendMediaArgs,
  ProviderSendReactionArgs,
  ProviderSendResult,
  ProviderSendTemplateArgs,
  ProviderSendTextArgs,
  WhatsAppProvider,
} from '@/lib/whatsapp/provider/types';

export interface EvolutionProviderOptions {
  /** Bloqueia até o envio para `to` poder sair. Omitido = sem fila (testes). */
  throttle?: Throttle;
}

/** "Digitando…" de 0,6 s a 1,8 s, conforme o tamanho — nunca instantâneo. */
export function typingDelayMs(text: string): number {
  return Math.min(1800, Math.max(600, text.length * 15));
}

const DOC_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
};

function documentMime(filename?: string, link?: string): string {
  const source = filename || (link ? link.split('?')[0] : '') || '';
  const ext = source.split('.').pop()?.toLowerCase() ?? '';
  return DOC_MIME[ext] ?? 'application/octet-stream';
}

export const TEMPLATES_UNSUPPORTED_MESSAGE =
  'Modelos de mensagem (templates) existem só na API oficial da Meta. No canal QR code, envie texto ou mídia comum.';

export function evolutionProvider(
  creds: EvolutionCreds,
  options: EvolutionProviderOptions = {}
): WhatsAppProvider {
  const wait = options.throttle ?? (async () => {});

  async function text(
    to: string,
    body: string,
    contextMessageId?: string
  ): Promise<ProviderSendResult> {
    await wait(to);
    return sendText(creds, {
      number: to,
      text: body,
      delayMs: typingDelayMs(body),
      quotedMessageId: contextMessageId,
    });
  }

  return {
    kind: 'evolution',

    // Um único endereço: o Baileys resolve o número (inclusive o nono
    // dígito) sozinho; não há "tente a próxima variante".
    addressVariants: (phone: string) => (phone ? [phone] : []),
    isRetryableAddressError: () => false,

    sendText: (args: ProviderSendTextArgs) =>
      text(args.to, args.text, args.contextMessageId),

    async sendMedia(args: ProviderSendMediaArgs): Promise<ProviderSendResult> {
      if (args.kind === 'audio') {
        await wait(args.to);
        return sendAudio(creds, {
          number: args.to,
          audio: args.link,
          delayMs: 1200,
          quotedMessageId: args.contextMessageId,
        });
      }
      await wait(args.to);
      return sendMedia(creds, {
        number: args.to,
        mediatype: args.kind,
        media: args.link,
        caption: args.caption,
        fileName: args.kind === 'document' ? args.filename : undefined,
        mimetype:
          args.kind === 'document' ? documentMime(args.filename, args.link) : undefined,
        delayMs: 1000,
        quotedMessageId: args.contextMessageId,
      });
    },

    // Nota de voz (PTT): endpoint próprio, para o WhatsApp mostrar a
    // gravação de microfone em vez de um arquivo anexado.
    async sendAudio(args: ProviderSendAudioArgs): Promise<ProviderSendResult> {
      await wait(args.to);
      return sendAudio(creds, {
        number: args.to,
        audio: args.link,
        delayMs: 1200,
        quotedMessageId: args.contextMessageId,
      });
    },

    async sendTemplate(_args: ProviderSendTemplateArgs): Promise<ProviderSendResult> {
      throw new EvolutionError('invalid_config', TEMPLATES_UNSUPPORTED_MESSAGE);
    },

    sendInteractiveButtons(args: ProviderSendInteractiveButtonsArgs) {
      return text(
        args.to,
        renderNumberedText({
          headerText: args.headerText,
          bodyText: args.bodyText,
          footerText: args.footerText,
          options: optionsFromButtons(args.buttons),
        }),
        args.contextMessageId
      );
    },

    sendInteractiveList(args: ProviderSendInteractiveListArgs) {
      return text(
        args.to,
        renderNumberedText({
          headerText: args.headerText,
          bodyText: args.bodyText,
          footerText: args.footerText,
          options: optionsFromSections(args.sections),
          descriptions: descriptionsFromSections(args.sections),
        }),
        args.contextMessageId
      );
    },

    async sendReaction(args: ProviderSendReactionArgs): Promise<ProviderSendResult> {
      // Reagir não é uma mensagem nova: sem fila nem "digitando…".
      return sendReaction(creds, {
        remoteJid: args.to.includes('@') ? args.to : `${args.to}@s.whatsapp.net`,
        targetMessageId: args.targetMessageId,
        fromMe: false,
        emoji: args.emoji,
      });
    },

    async sendTyping(args: { to: string; durationMs?: number }): Promise<void> {
      await sendPresence(creds, {
        number: args.to,
        presence: 'composing',
        delayMs: args.durationMs ?? 1200,
      });
    },

    async markRead(args: { to: string; messageId: string }): Promise<void> {
      await markAsRead(creds, {
        remoteJid: args.to.includes('@') ? args.to : `${args.to}@s.whatsapp.net`,
        messageId: args.messageId,
        fromMe: false,
      });
    },
  };
}
