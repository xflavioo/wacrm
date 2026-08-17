// ============================================================
// Provedor Meta Cloud API.
//
// Adaptador puro sobre `meta-api.ts`: nenhuma regra nova, nenhuma
// chamada de rede própria. A única coisa que ele acrescenta é vincular
// `phoneNumberId` + `accessToken` uma vez, em vez de repassá-los em
// cada chamada — que era o motivo de os caminhos de envio
// precisarem carregar a config inteira até o ponto do fetch.
// ============================================================

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type {
  WhatsAppProvider,
  ProviderSendTextArgs,
  ProviderSendMediaArgs,
  ProviderSendAudioArgs,
  ProviderSendTemplateArgs,
  ProviderSendInteractiveButtonsArgs,
  ProviderSendInteractiveListArgs,
  ProviderSendReactionArgs,
  ProviderSendResult,
} from './types';

export interface MetaCredentials {
  phoneNumberId: string;
  /** Já descriptografado. */
  accessToken: string;
}

export function metaProvider(creds: MetaCredentials): WhatsAppProvider {
  const { phoneNumberId, accessToken } = creds;
  const auth = { phoneNumberId, accessToken };

  return {
    kind: 'meta',

    addressVariants: (phone: string) => phoneVariants(phone),
    // Stringifica aqui — a mesma linha que os chamadores tinham
    // antes do check. É política da Meta procurar o 131030 no texto.
    // TOTAL por construção: este predicado roda dentro do `catch` dos
    // loops de broadcast, fora de qualquer try — se ele próprio
    // lançasse (String() num objeto sem conversão primitiva), a exceção
    // abortaria o broadcast inteiro. Um não-Error nunca é retryable.
    isRetryableAddressError: (error: unknown) =>
      error instanceof Error && isRecipientNotAllowedError(error.message),

    async sendText(args: ProviderSendTextArgs): Promise<ProviderSendResult> {
      return sendTextMessage({
        ...auth,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendMedia(args: ProviderSendMediaArgs): Promise<ProviderSendResult> {
      return sendMediaMessage({
        ...auth,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      });
    },

    // A Meta não distingue nota de voz de arquivo de áudio no envio —
    // é o mesmo endpoint com `type: audio`. O desvio existe para a
    // Evolution, que tem endpoint dedicado.
    async sendAudio(args: ProviderSendAudioArgs): Promise<ProviderSendResult> {
      return sendMediaMessage({
        ...auth,
        to: args.to,
        kind: 'audio',
        link: args.link,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendTemplate(
      args: ProviderSendTemplateArgs
    ): Promise<ProviderSendResult> {
      return sendTemplateMessage({
        ...auth,
        to: args.to,
        templateName: args.templateName,
        language: args.language,
        template: args.template,
        messageParams: args.messageParams,
        params: args.params,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendInteractiveButtons(
      args: ProviderSendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      return sendInteractiveButtons({
        ...auth,
        to: args.to,
        bodyText: args.bodyText,
        buttons: args.buttons,
        headerText: args.headerText,
        footerText: args.footerText,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendInteractiveList(
      args: ProviderSendInteractiveListArgs
    ): Promise<ProviderSendResult> {
      return sendInteractiveList({
        ...auth,
        to: args.to,
        bodyText: args.bodyText,
        buttonLabel: args.buttonLabel,
        sections: args.sections,
        headerText: args.headerText,
        footerText: args.footerText,
        contextMessageId: args.contextMessageId,
      });
    },

    async sendReaction(
      args: ProviderSendReactionArgs
    ): Promise<ProviderSendResult> {
      return sendReactionMessage({
        ...auth,
        to: args.to,
        targetMessageId: args.targetMessageId,
        emoji: args.emoji,
      });
    },
  };
}
