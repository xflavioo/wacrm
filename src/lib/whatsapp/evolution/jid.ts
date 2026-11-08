// ============================================================
// JIDs do WhatsApp ↔ telefone.
//
// Um JID é `<id>@<servidor>`:
//   5591988887777@s.whatsapp.net   usuário (número real)
//   5591988887777:12@s.whatsapp.net usuário, com sufixo de dispositivo
//   1234567890123@lid              usuário endereçado por LID (anônimo)
//   120363...@g.us                 grupo
//   status@broadcast               status/stories
//   120363...@newsletter           canal
//
// Versões novas do WhatsApp entregam o remetente como `@lid`, que NÃO é
// um telefone; o número real vem num campo alternativo (`remoteJidAlt`,
// `senderPn`…, conforme a versão do Evolution). Um LID jamais pode virar
// `contacts.phone`.
// ============================================================

export type JidKind =
  | 'user'
  | 'lid'
  | 'group'
  | 'status'
  | 'newsletter'
  | 'broadcast'
  | 'other';

export function jidKind(jid: string | null | undefined): JidKind {
  if (!jid) return 'other';
  const j = jid.toLowerCase();
  if (j === 'status@broadcast') return 'status';
  if (j.endsWith('@g.us')) return 'group';
  if (j.endsWith('@newsletter')) return 'newsletter';
  if (j.endsWith('@broadcast')) return 'broadcast';
  if (j.endsWith('@lid')) return 'lid';
  if (j.endsWith('@s.whatsapp.net') || j.endsWith('@c.us')) return 'user';
  return 'other';
}

/** Dígitos de um JID de usuário (sem o sufixo `:dispositivo`); null se não for plausível. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid || jidKind(jid) !== 'user') return null;
  const local = jid.split('@')[0].split(':')[0];
  const digits = local.replace(/\D/g, '');
  return isPlausiblePhone(digits) ? digits : null;
}

/** 8–15 dígitos (E.164 sem o `+`), sem zero à esquerda. */
export function isPlausiblePhone(digits: string): boolean {
  return /^[1-9]\d{7,14}$/.test(digits);
}

/**
 * Forma canônica brasileira para o CRM: `55` + DDD (2) + `9` + 8 dígitos.
 *
 * O WhatsApp ainda entrega JIDs de celulares antigos SEM o nono dígito
 * (`559188887777`) enquanto as pessoas cadastram COM ele
 * (`5591988887777`). Sem normalizar, o mesmo cliente viraria dois
 * contatos. Regra: número de 12 dígitos começando em 55 cujo assinante
 * começa em 6–9 é celular no formato antigo → insere o 9 após o DDD.
 * Fixos (assinante começando em 2–5) ficam como estão.
 *
 * Qualquer número fora do Brasil passa intacto.
 */
export function normalizeBrazilianMobile(digits: string): string {
  if (/^55[1-9]\d[6-9]\d{7}$/.test(digits)) {
    return `${digits.slice(0, 4)}9${digits.slice(4)}`;
  }
  return digits;
}

/**
 * Primeiro número real entre os campos candidatos (JIDs ou dígitos).
 * Usado para sair de um LID: `remoteJidAlt`, `senderPn`, `participantAlt`…
 */
export function firstRealPhone(
  candidates: Array<string | null | undefined>
): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const fromJid = phoneFromJid(c);
    if (fromJid) return fromJid;
    // Alguns campos vêm só com dígitos, sem `@servidor`.
    if (!c.includes('@')) {
      const digits = c.replace(/\D/g, '');
      if (isPlausiblePhone(digits)) return digits;
    }
  }
  return null;
}
