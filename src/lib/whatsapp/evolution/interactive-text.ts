// ============================================================
// Mensagens interativas no canal QR: texto numerado.
//
// Botões e listas nativos não são confiáveis no WhatsApp não oficial
// (a Baileys os envia, mas o aparelho do cliente costuma exibir uma
// mensagem em branco). Então, no Evolution, o wacrm manda:
//
//   Como podemos ajudar?
//
//   1) Reservar uma festa
//   2) Ver o cardápio
//
//   Responda com o número da opção (1 a 2).
//
// e, quando o cliente responde "2" (ou o texto exato da opção), o
// webhook de entrada converte a resposta de volta num toque de botão
// (`interactive_reply_id`) para os fluxos e automações continuarem
// funcionando como na Meta.
// ============================================================

import type {
  InteractiveButton,
  InteractiveListSection,
} from '@/lib/whatsapp/meta-api';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

export interface NumberedOption {
  id: string;
  title: string;
}

/** Opções na ordem em que serão numeradas (1-based na exibição). */
export function optionsFromButtons(buttons: InteractiveButton[]): NumberedOption[] {
  return buttons.map((b) => ({ id: b.id, title: b.title }));
}

export function optionsFromSections(
  sections: InteractiveListSection[]
): NumberedOption[] {
  return sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })));
}

export function optionsFromPayload(payload: InteractiveMessagePayload): NumberedOption[] {
  return payload.kind === 'buttons'
    ? optionsFromButtons(payload.buttons)
    : optionsFromSections(payload.sections);
}

/**
 * Corpo da mensagem numerada. `rows` de lista com `description` ganham
 * a descrição na linha seguinte.
 */
export function renderNumberedText(args: {
  headerText?: string;
  bodyText: string;
  footerText?: string;
  options: NumberedOption[];
  /** Descrições por id (listas). */
  descriptions?: Record<string, string | undefined>;
}): string {
  const { headerText, bodyText, footerText, options, descriptions } = args;
  const parts: string[] = [];
  if (headerText?.trim()) parts.push(`*${headerText.trim()}*`);
  parts.push(bodyText.trim());

  const lines = options.map((o, i) => {
    const desc = descriptions?.[o.id]?.trim();
    return desc ? `${i + 1}) ${o.title}\n    ${desc}` : `${i + 1}) ${o.title}`;
  });
  parts.push(lines.join('\n'));

  parts.push(
    options.length === 1
      ? 'Responda com o número da opção (1).'
      : `Responda com o número da opção (1 a ${options.length}).`
  );
  if (footerText?.trim()) parts.push(`_${footerText.trim()}_`);
  return parts.join('\n\n');
}

export function descriptionsFromSections(
  sections: InteractiveListSection[]
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const s of sections) for (const r of s.rows) out[r.id] = r.description;
  return out;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Casa a resposta do cliente com uma opção da última mensagem numerada.
 * Aceita "2", "2)", "opção 2", "opcao 2" e o título da opção (sem
 * acento/caixa). Qualquer outra coisa → null (é uma mensagem normal).
 */
export function matchNumberedReply(
  options: NumberedOption[],
  text: string
): NumberedOption | null {
  const t = norm(text);
  if (!t) return null;

  const m = /^(?:opcao |opção )?(\d{1,2})$/.exec(t);
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= options.length ? options[n - 1] : null;
  }

  const exact = options.filter((o) => norm(o.title) === t);
  return exact.length === 1 ? exact[0] : null;
}
