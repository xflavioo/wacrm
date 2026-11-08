import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse, UnauthorizedError, ForbiddenError } from '@/lib/auth/account';
import { EvolutionError, logoutInstance } from '@/lib/whatsapp/evolution/client';
import { evolutionCredsFromRow, loadEvolutionRow } from '@/lib/whatsapp/evolution/config';
import { evolutionErrorResponse } from '@/lib/whatsapp/evolution/http';

// POST /api/whatsapp/evolution/disconnect (somente owner/admin)
//
// Faz logout da instância no Evolution (o aparelho sai de "Aparelhos
// conectados") e marca o canal como desconectado. A configuração
// (URL, instância, API key) é mantida para reconectar com um novo QR.
export async function POST() {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const row = await loadEvolutionRow(supabase, accountId);
    if (!row) {
      return NextResponse.json(
        { error: 'O canal Evolution não está configurado.' },
        { status: 400 }
      );
    }

    const creds = evolutionCredsFromRow(row);
    try {
      await logoutInstance(creds);
    } catch (err) {
      // Instância já deslogada/inexistente: o objetivo (estar
      // desconectado) já foi atingido — segue e atualiza o banco.
      const alreadyGone =
        err instanceof EvolutionError &&
        (err.code === 'bad_request' || err.code === 'not_found');
      if (!alreadyGone) throw err;
    }

    const { error } = await supabase
      .from('whatsapp_config')
      .update({
        status: 'disconnected',
        evolution_phone: null,
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);
    if (error) {
      console.error('[evolution/disconnect] update failed:', error.message);
      return NextResponse.json({ error: 'Falha ao atualizar o status.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, status: 'disconnected' });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    return evolutionErrorResponse(err);
  }
}
