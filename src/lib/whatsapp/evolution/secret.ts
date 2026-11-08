// ============================================================
// Segredo do webhook da Evolution.
//
// O segredo vai no PATH da URL registrada no Evolution
// (`/api/evolution/webhook/<segredo>`) — o Evolution v2 não assina o
// corpo, então a URL é a credencial. Por isso:
//   * 256 bits aleatórios (base64url, 43 caracteres);
//   * o banco guarda só o SHA-256 (hex); quem lê a tabela não consegue
//     forjar eventos;
//   * a conferência é em tempo constante, sobre os hashes — comparar o
//     segredo em claro com `===` vazaria o prefixo por timing.
// ============================================================

import crypto from 'crypto';

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashWebhookSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Compara dois hashes hex em tempo constante. Strings de tamanho diferente → false. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Formato aceito para um segredo recebido na URL (evita hashear lixo gigante). */
export function isPlausibleSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(value);
}
