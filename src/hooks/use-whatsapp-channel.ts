'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';

export type WhatsAppChannel = 'meta' | 'evolution';

export interface WhatsAppChannelInfo {
  /** Canal ativo da conta. `meta` até carregar (comportamento original). */
  provider: WhatsAppChannel;
  /** True quando o canal é o QR code (Evolution): sem templates, sem janela de 24 h. */
  isQr: boolean;
  /** Teto de destinatários por disparo no canal QR. */
  broadcastMax: number;
  /** True depois que a leitura terminou. */
  ready: boolean;
}

const DEFAULT_BROADCAST_MAX = 50;

// Cache por conta: o canal só muda na tela de configurações, e cada
// componente do inbox chama este hook — não vale uma consulta por montagem.
const cache = new Map<string, { provider: WhatsAppChannel; broadcastMax: number }>();

/**
 * Canal do WhatsApp da conta (`whatsapp_config.provider`).
 *
 * Padrão `meta` enquanto carrega e quando a leitura falha (banco sem as
 * migrações 040/041): assim nada muda para quem usa a API oficial.
 */
export function useWhatsAppChannel(): WhatsAppChannelInfo {
  const { accountId } = useAuth();
  const [state, setState] = useState<{
    provider: WhatsAppChannel;
    broadcastMax: number;
    ready: boolean;
  }>(() => {
    const hit = accountId ? cache.get(accountId) : undefined;
    return hit
      ? { ...hit, ready: true }
      : { provider: 'meta', broadcastMax: DEFAULT_BROADCAST_MAX, ready: false };
  });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from('whatsapp_config')
      .select('provider, evolution_broadcast_max')
      .eq('account_id', accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        const next = {
          provider: (!error && data?.provider === 'evolution' ? 'evolution' : 'meta') as WhatsAppChannel,
          broadcastMax:
            (!error && data?.evolution_broadcast_max) || DEFAULT_BROADCAST_MAX,
        };
        cache.set(accountId, next);
        setState({ ...next, ready: true });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return {
    provider: state.provider,
    isQr: state.provider === 'evolution',
    broadcastMax: state.broadcastMax,
    ready: state.ready,
  };
}
