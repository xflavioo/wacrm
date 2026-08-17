// ============================================================
// A fronteira entre o CRM e o transporte de WhatsApp.
//
// Só o que DIFERE entre provedores mora aqui. Buscar o contato,
// persistir em `messages` e atualizar `conversations` é idêntico nos
// dois casos e continua nos chamadores — mover isso para cá teria
// transformado um refactor de transporte numa reescrita da camada de
// dados.
//
// `addressVariants` e `isRetryableAddressError` são parte da interface
// porque o retry de variante de telefone é POLÍTICA DE PROVEDOR, não
// regra de negócio: existe por causa do sandbox da Meta (erro 131030) e
// não faz sentido no Baileys. Deixá-lo hard-coded nos chamadores faria
// a Evolution herdar tentativas inúteis — e, pior, o write-back em
// `contacts.phone` poderia gravar uma variante fabricada por cima do
// telefone real.
// ============================================================

import type {
  InteractiveButton,
  InteractiveListSection,
  MediaKind,
} from '@/lib/whatsapp/meta-api';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate, WhatsAppProviderKind } from '@/types';

/**
 * Alias, não redeclaração: o discriminador tem UMA fonte de verdade
 * (`WhatsAppProviderKind` em `@/types`, ao lado da união de config).
 * Redeclarar o literal aqui criaria dois vocabulários idênticos que
 * divergem no primeiro provedor novo.
 */
export type ProviderKind = WhatsAppProviderKind;

export interface ProviderSendResult {
  /** O id do provedor: `wamid...` na Meta, `key.id` na Evolution. */
  messageId: string;
}

export interface ProviderSendTextArgs {
  to: string;
  text: string;
  contextMessageId?: string;
}

export interface ProviderSendMediaArgs {
  to: string;
  kind: MediaKind;
  link: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}

export interface ProviderSendAudioArgs {
  to: string;
  link: string;
  contextMessageId?: string;
}

export interface ProviderSendTemplateArgs {
  to: string;
  templateName: string;
  language?: string;
  template?: MessageTemplate;
  /**
   * Tipado como `SendTimeParams` (não `unknown`): é o que
   * `sendTemplateMessage` aceita, e um `unknown` aqui obrigaria o
   * adaptador Meta a um cast — além de jogar fora a checagem que a
   * rota de broadcast já tem hoje.
   */
  messageParams?: SendTimeParams;
  params?: string[];
  contextMessageId?: string;
}

export interface ProviderSendInteractiveButtonsArgs {
  to: string;
  bodyText: string;
  buttons: InteractiveButton[];
  headerText?: string;
  footerText?: string;
  contextMessageId?: string;
}

export interface ProviderSendInteractiveListArgs {
  to: string;
  bodyText: string;
  buttonLabel: string;
  sections: InteractiveListSection[];
  headerText?: string;
  footerText?: string;
  contextMessageId?: string;
}

export interface ProviderSendReactionArgs {
  to: string;
  /**
   * Mensagem sendo reagida, no id do provedor. O nome do campo segue
   * `sendReactionMessage` em `meta-api.ts:680` — `targetMessageId`,
   * não `messageId` — para o adaptador ser repasse puro.
   */
  targetMessageId: string;
  /** Emoji, ou string vazia para remover a reação. */
  emoji: string;
}

export interface WhatsAppProvider {
  readonly kind: ProviderKind;

  /**
   * Endereços a tentar, em ordem, para um telefone E.164. A Meta
   * devolve variantes de trunk-0 (sandbox); provedores sem essa quirk
   * devolvem um único elemento.
   */
  addressVariants(phone: string): string[];

  /**
   * True quando o erro significa "tente o próximo endereço".
   *
   * Recebe o erro CRU (`unknown`), não a mensagem: hoje `meta-api.ts`
   * lança `new Error(prose)` e o predicado da Meta procura o código
   * 131030 no texto — mas um provedor que exponha status HTTP ou corpo
   * JSON estruturado precisa poder decidir por eles, sem ser obrigado
   * a traduzir seus erros para inglês-da-Meta. Cada provedor stringifica
   * do jeito que precisar.
   */
  isRetryableAddressError(error: unknown): boolean;

  sendText(args: ProviderSendTextArgs): Promise<ProviderSendResult>;
  sendMedia(args: ProviderSendMediaArgs): Promise<ProviderSendResult>;
  /**
   * Nota de voz (PTT). Existe separado de `sendMedia` porque os dois
   * provedores tratam áudio de formas diferentes: a Meta manda pelo
   * mesmo endpoint de mídia com `type: audio`, enquanto a Evolution
   * tem `POST /message/sendWhatsAppAudio/{instance}`, que é o que faz
   * o WhatsApp renderizar como gravação de microfone em vez de
   * arquivo anexado. Colapsar os dois em `sendMedia` obrigaria o
   * provedor Evolution a inspecionar `kind` e desviar — o desvio fica
   * aqui, explícito na interface.
   *
   * Nenhum chamador usa isto ainda: hoje todos mandam áudio por
   * `sendMedia({ kind: 'audio' })`, e este plano NÃO os muda. O método
   * existe para o provedor Evolution do plano 2 ter onde encaixar.
   */
  sendAudio(args: ProviderSendAudioArgs): Promise<ProviderSendResult>;
  sendTemplate(args: ProviderSendTemplateArgs): Promise<ProviderSendResult>;
  sendInteractiveButtons(
    args: ProviderSendInteractiveButtonsArgs
  ): Promise<ProviderSendResult>;
  sendInteractiveList(
    args: ProviderSendInteractiveListArgs
  ): Promise<ProviderSendResult>;
  /**
   * Devolve `ProviderSendResult` como os demais: `sendReactionMessage`
   * já retorna o wamid da reação, e descartá-lo aqui só criaria uma
   * exceção de forma na interface. O chamador atual ignora o valor.
   */
  sendReaction(args: ProviderSendReactionArgs): Promise<ProviderSendResult>;
}
