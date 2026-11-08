import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { EvolutionConfigRow } from '@/lib/whatsapp/evolution/config';
import { EnvelopeSchema } from '@/lib/whatsapp/evolution/payload';
import {
  hashWebhookSecret,
  hashesEqual,
  isPlausibleSecret,
} from '@/lib/whatsapp/evolution/secret';
import { processEvolutionEvent } from '@/lib/whatsapp/evolution/webhook-handler';

// Eventos de mídia grande e a espera antes de tratar mensagens `fromMe`
// rodam dentro do `after()`: dê folga além do padrão da plataforma.
export const maxDuration = 60;

/** Tamanho máximo aceito. O webhook é configurado SEM base64, então é pequeno. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const UNAUTHORIZED = () =>
  NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

/**
 * POST /api/evolution/webhook/[secret]
 *
 * Entrada dos eventos do Evolution. A autenticação é o segredo no path
 * (o Evolution v2 não assina o corpo): o servidor guarda só o SHA-256
 * dele, acha a conta pelo hash e confere em tempo constante. Segredo
 * ausente, malformado ou desconhecido → 401, sempre com a mesma
 * resposta (nada revela se o formato ou o valor foi o problema).
 *
 * Responde 200 logo e processa em `after()` — mesmo padrão do webhook
 * da Meta: o Evolution não espera o fan-out de fluxos/IA.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ secret: string }> }
) {
  const { secret } = await ctx.params;

  if (!isPlausibleSecret(secret)) return UNAUTHORIZED();

  const hash = hashWebhookSecret(secret);
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('provider', 'evolution')
    .eq('evolution_webhook_secret_hash', hash)
    .maybeSingle();

  if (error) {
    console.error('[evolution webhook] config lookup failed:', error.message);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
  const row = data as EvolutionConfigRow | null;
  // Confirma em tempo constante, mesmo achando por índice único.
  if (!row?.evolution_webhook_secret_hash || !hashesEqual(hash, row.evolution_webhook_secret_hash)) {
    return UNAUTHORIZED();
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  // Evento de OUTRA instância chegando nesta URL: configuração trocada.
  // Não processa (não deve gravar na conta errada) mas também não faz o
  // Evolution reenviar em loop.
  const instance = envelope.data.instance;
  if (instance && row.evolution_instance && instance !== row.evolution_instance) {
    console.warn('[evolution webhook] event for a different instance ignored');
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  // Processa DEPOIS da resposta. `after()` (e não uma promise solta) para
  // a função serverless não ser congelada com a escrita pela metade —
  // ver o comentário equivalente no webhook da Meta (issue #301).
  after(async () => {
    try {
      await processEvolutionEvent(db, row, envelope.data);
    } catch (err) {
      console.error('[evolution webhook] processing failed:', err);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}
