import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  connectInstance,
  fetchConnectedNumber,
  getConnectionState,
} from '@/lib/whatsapp/evolution/client';
import {
  evolutionCredsFromRow,
  loadEvolutionRow,
  stateToStatus,
} from '@/lib/whatsapp/evolution/config';
import { evolutionErrorResponse } from '@/lib/whatsapp/evolution/http';

// GET /api/whatsapp/evolution/connect[?qr=0]
//
// Chamada pela tela enquanto o QR está aberto (somente owner/admin).
//   - consulta o estado da instância no Evolution;
//   - conectada → grava `connected` + número e devolve sem QR;
//   - senão → pede um QR novo e devolve o data URL (a menos que `qr=0`,
//     usado entre uma renovação e outra só para acompanhar o estado).
//
// O QR é credencial de pareamento e expira em ~20 s: é repassado ao
// navegador e NUNCA gravado (decisão D9 da migração 060).
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const row = await loadEvolutionRow(supabase, accountId);
    if (!row) {
      return NextResponse.json(
        { error: 'Configure o canal Evolution antes de conectar.' },
        { status: 400 }
      );
    }

    const creds = evolutionCredsFromRow(row);
    const wantQr = new URL(request.url).searchParams.get('qr') !== '0';

    const state = await getConnectionState(creds);
    const status = stateToStatus(state);

    if (state === 'open') {
      const phone = (await fetchConnectedNumber(creds).catch(() => null)) ?? row.evolution_phone;
      if (row.status !== 'connected' || phone !== row.evolution_phone) {
        await supabase
          .from('whatsapp_config')
          .update({
            status: 'connected',
            evolution_phone: phone,
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId);
      }
      return noStore({ state, status, phone });
    }

    let qr: string | null = null;
    let pairingCode: string | null = null;
    if (wantQr) {
      const result = await connectInstance(creds);
      qr = result.qrDataUrl;
      pairingCode = result.pairingCode;
    }

    if (row.status !== status) {
      await supabase
        .from('whatsapp_config')
        .update({
          status,
          evolution_phone: status === 'disconnected' ? null : row.evolution_phone,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId);
    }

    return noStore({ state, status, qr, pairingCode });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    return evolutionErrorResponse(err);
  }
}

function noStore(body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
