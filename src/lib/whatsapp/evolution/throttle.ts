// ============================================================
// Ritmo de envio antibanimento.
//
// O WhatsApp não oficial pune quem manda mais rápido do que um humano.
// A regra (configurável por conta, migração 041):
//   * enviar para o MESMO número da última mensagem não espera — é uma
//     conversa, o humano está respondendo em sequência;
//   * enviar para um número DIFERENTE só depois de
//     `min_interval + random(0..jitter)` desde o slot anterior.
//
// A reserva do slot é feita no banco (`claim_evolution_send_slot`), de
// forma atômica, porque o app roda em serverless: um contador em memória
// não enxerga as outras instâncias. Aqui só se calcula quanto dormir.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Teto de espera por envio. Um slot além disso significa uma fila muito
 * longa para um request HTTP: melhor falhar claro do que pendurar a
 * função até o timeout da plataforma.
 */
export const MAX_THROTTLE_WAIT_MS = 45_000;

export class SendQueueFullError extends Error {
  constructor(waitMs: number) {
    super(
      `Fila de envio cheia: o próximo envio só sairia em ${Math.ceil(waitMs / 1000)} segundos. ` +
        'Aguarde alguns instantes e tente de novo — o ritmo é limitado para proteger o número contra banimento.'
    );
    this.name = 'SendQueueFullError';
  }
}

export interface ThrottleDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Função injetada no provedor: bloqueia até o envio para `to` poder sair. */
export type Throttle = (to: string) => Promise<void>;

export function dbThrottle(
  db: SupabaseClient,
  accountId: string,
  deps: ThrottleDeps = {}
): Throttle {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  return async (to: string) => {
    const { data, error } = await db.rpc('claim_evolution_send_slot', {
      p_account_id: accountId,
      p_to: to,
    });
    if (error) {
      // Sem a função (migração 041 não aplicada) ou banco fora: não trava
      // o envio de um humano por causa da proteção — registra e segue.
      console.warn('[evolution] send throttle unavailable:', error.message);
      return;
    }
    const slot = typeof data === 'string' ? Date.parse(data) : NaN;
    if (!Number.isFinite(slot)) return;

    const wait = slot - now();
    if (wait <= 0) return;
    if (wait > MAX_THROTTLE_WAIT_MS) throw new SendQueueFullError(wait);
    await sleep(wait);
  };
}
