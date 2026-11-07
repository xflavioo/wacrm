import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createClient as createAdminClient } from '@supabase/supabase-js';
import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  EVOLUTION_WEBHOOK_EVENTS,
  assertInstanceName,
  fetchConnectedNumber,
  getConnectionState,
  normalizeBaseUrl,
  setWebhook,
} from '@/lib/whatsapp/evolution/client';
import {
  EvolutionConfigError,
  evolutionCredsFromRow,
  stateToStatus,
} from '@/lib/whatsapp/evolution/config';
import { evolutionErrorResponse } from '@/lib/whatsapp/evolution/http';
import {
  generateWebhookSecret,
  hashWebhookSecret,
} from '@/lib/whatsapp/evolution/secret';

// Configuração do canal Evolution (QR code) da conta.
//
//   GET  — estado atual, SEM segredos (qualquer membro da conta).
//   POST — salva URL/instância/API key, valida no servidor Evolution,
//          registra o webhook e grava (somente owner/admin).
//
// Fica em /api/whatsapp/evolution/* de propósito: o middleware já exige
// sessão em /api/whatsapp/*. Isso NÃO substitui a checagem de papel
// abaixo — o middleware só separa autenticado de anônimo.

// Cliente service-role só para a checagem de colisão de instância entre
// contas (a RLS esconde as linhas dos outros).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null;
function supabaseAdmin() {
  if (!_admin) {
    _admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _admin;
}

const BodySchema = z.object({
  url: z.string().trim().min(1, 'Informe a URL do servidor Evolution.').max(300),
  instance: z.string().trim().min(1, 'Informe o nome da instância.').max(100),
  /** Vazia/ausente = manter a chave já salva. */
  api_key: z.string().trim().max(500).optional(),
  min_interval_ms: z.number().int().min(1000).max(120_000).optional(),
  jitter_ms: z.number().int().min(0).max(60_000).optional(),
  broadcast_max: z.number().int().min(1).max(1000).optional(),
});

/** Origem pública do wacrm, para o Evolution conseguir chamar o webhook. */
function publicOrigin(request: Request): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) return site.replace(/\/+$/, '');
  const proto = request.headers.get('x-forwarded-proto');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (host) return `${proto ?? 'https'}://${host}`;
  return new URL(request.url).origin;
}

function isLocalHost(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select(
        'provider, status, evolution_url, evolution_instance, evolution_phone, evolution_min_interval_ms, evolution_jitter_ms, evolution_broadcast_max'
      )
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[evolution/config GET]', error.message);
      return NextResponse.json({ error: 'Falha ao carregar a configuração.' }, { status: 500 });
    }
    // Resposta enxuta e sem segredos: nem a API key, nem o hash do webhook.
    return NextResponse.json({
      provider: data?.provider ?? null,
      configured: data?.provider === 'evolution',
      status: data?.provider === 'evolution' ? data.status : null,
      url: data?.provider === 'evolution' ? data.evolution_url : null,
      instance: data?.provider === 'evolution' ? data.evolution_instance : null,
      phone: data?.provider === 'evolution' ? data.evolution_phone : null,
      min_interval_ms: data?.evolution_min_interval_ms ?? 6000,
      jitter_ms: data?.evolution_jitter_ms ?? 4000,
      broadcast_max: data?.evolution_broadcast_max ?? 50,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' },
        { status: 400 }
      );
    }
    const body = parsed.data;

    let baseUrl: string;
    let instance: string;
    try {
      baseUrl = normalizeBaseUrl(body.url);
      instance = assertInstanceName(body.instance);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Dados inválidos.' },
        { status: 400 }
      );
    }

    // Linha existente da conta (RLS) — define se é troca de provedor e
    // se dá para reaproveitar a API key salva.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    let apiKey = body.api_key ?? '';
    let encryptedKey: string;
    if (apiKey) {
      encryptedKey = encrypt(apiKey);
    } else if (existing?.provider === 'evolution') {
      // Mesma URL/instância → reaproveita a chave; mudou o servidor, exige
      // chave nova (não mandar a chave de um servidor para outro).
      if (existing.evolution_url !== baseUrl) {
        return NextResponse.json(
          { error: 'Ao trocar o servidor Evolution, informe a API key novamente.' },
          { status: 400 }
        );
      }
      try {
        apiKey = evolutionCredsFromRow(existing).apiKey;
      } catch (err) {
        if (err instanceof EvolutionConfigError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
      encryptedKey = existing.access_token;
    } else {
      return NextResponse.json({ error: 'Informe a API key do Evolution.' }, { status: 400 });
    }

    // A mesma instância não pode estar ligada a duas contas: o webhook
    // de uma entregaria mensagens da outra.
    const { data: clash } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('provider', 'evolution')
      .eq('evolution_url', baseUrl)
      .eq('evolution_instance', instance)
      .neq('account_id', accountId)
      .maybeSingle();
    if (clash) {
      return NextResponse.json(
        { error: 'Esta instância já está vinculada a outra conta deste wacrm.' },
        { status: 409 }
      );
    }

    const creds = { baseUrl, instance, apiKey };

    // 1) Valida URL + chave + instância num só passo.
    let state: 'open' | 'connecting' | 'close';
    try {
      state = await getConnectionState(creds);
    } catch (err) {
      return evolutionErrorResponse(err);
    }

    // 2) Registra o webhook com um segredo NOVO. Só persiste depois que o
    //    servidor aceitou — se falhar, o segredo anterior segue valendo.
    const secret = generateWebhookSecret();
    const origin = publicOrigin(request);
    const webhookUrl = `${origin}/api/evolution/webhook/${secret}`;
    try {
      await setWebhook(creds, webhookUrl, EVOLUTION_WEBHOOK_EVENTS);
    } catch (err) {
      return evolutionErrorResponse(err);
    }

    let phone: string | null = null;
    if (state === 'open') {
      phone = await fetchConnectedNumber(creds).catch(() => null);
    }

    const status = stateToStatus(state);
    const now = new Date().toISOString();
    const row = {
      provider: 'evolution',
      access_token: encryptedKey,
      evolution_url: baseUrl,
      evolution_instance: instance,
      evolution_webhook_secret_hash: hashWebhookSecret(secret),
      evolution_phone: phone,
      status,
      connected_at: status === 'connected' ? now : null,
      ...(body.min_interval_ms !== undefined && { evolution_min_interval_ms: body.min_interval_ms }),
      ...(body.jitter_ms !== undefined && { evolution_jitter_ms: body.jitter_ms }),
      ...(body.broadcast_max !== undefined && { evolution_broadcast_max: body.broadcast_max }),
      // Troca Meta → Evolution: o CHECK da 040 exige a identidade Meta
      // toda nula, e tem que ser na MESMA escrita.
      phone_number_id: null,
      waba_id: null,
      verify_token: null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
      evolution_next_send_at: null,
      evolution_last_to: null,
      updated_at: now,
    };

    if (existing) {
      const { error } = await supabase
        .from('whatsapp_config')
        .update(row)
        .eq('account_id', accountId);
      if (error) {
        console.error('[evolution/config] update failed:', error.message);
        return NextResponse.json({ error: 'Falha ao salvar a configuração.' }, { status: 500 });
      }
    } else {
      const { error } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: userId, ...row });
      if (error) {
        console.error('[evolution/config] insert failed:', error.message);
        return NextResponse.json({ error: 'Falha ao salvar a configuração.' }, { status: 500 });
      }
    }

    return NextResponse.json({
      success: true,
      status,
      phone,
      // A URL do webhook NÃO é devolvida: o segredo vive só no Evolution.
      webhook_registered: true,
      webhook_host: new URL(origin).host,
      warning: isLocalHost(origin) ? 'webhook_localhost' : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
