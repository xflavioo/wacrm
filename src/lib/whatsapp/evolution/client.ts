// ============================================================
// Cliente HTTP da Evolution API (v2.x).
//
// `fetch` puro, sem dependência. Toda função recebe as credenciais da
// conta (`EvolutionCreds`) — nada global, nada em log.
//
// Erros: sempre `EvolutionError`, com mensagem em pt-BR própria para
// mostrar ao usuário. A mensagem NUNCA inclui a API key nem a URL com
// segredo; só o que o servidor respondeu e o que fazer a respeito.
//
// Contrato com o servidor (Evolution v2):
//   GET    /instance/connect/{instance}            → QR (base64) ou {}
//   GET    /instance/connectionState/{instance}    → { instance: { state } }
//   GET    /instance/fetchInstances?instanceName=  → [{ ownerJid, ... }]
//   DELETE /instance/logout/{instance}
//   POST   /webhook/set/{instance}                 → v2.2+: { webhook: {...} }
//                                                    v2.0/2.1: corpo plano
//   POST   /message/sendText|sendMedia|sendWhatsAppAudio|sendReaction
//   POST   /chat/sendPresence|markMessageAsRead|getBase64FromMediaMessage
// Header de autenticação: `apikey`.
// ============================================================

export interface EvolutionCreds {
  /** Base URL do servidor, ex. `https://evolution.exemplo.com`. */
  baseUrl: string;
  instance: string;
  /** API key (global ou da instância), já descriptografada. */
  apiKey: string;
}

export type EvolutionConnectionState = 'open' | 'connecting' | 'close';

export class EvolutionError extends Error {
  /** Código estável para a UI/rotas decidirem o que fazer. */
  readonly code:
    | 'network'
    | 'timeout'
    | 'unauthorized'
    | 'not_found'
    | 'bad_request'
    | 'server'
    | 'invalid_response'
    | 'invalid_config';
  /** Status HTTP do Evolution, quando houve resposta. */
  readonly status: number | null;
  constructor(
    code: EvolutionError['code'],
    message: string,
    status: number | null = null
  ) {
    super(message);
    this.name = 'EvolutionError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 60_000;

/** Eventos que o wacrm consome. Nomes no formato de configuração do Evolution. */
export const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
] as const;

/**
 * Valida e normaliza a URL base: só http(s), sem barra final, sem
 * credenciais embutidas, sem query/hash. Lança `invalid_config`.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EvolutionError(
      'invalid_config',
      'A URL do servidor Evolution é inválida. Use algo como https://evolution.seudominio.com.'
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EvolutionError(
      'invalid_config',
      'A URL do servidor Evolution precisa começar com http:// ou https://.'
    );
  }
  if (url.username || url.password) {
    throw new EvolutionError(
      'invalid_config',
      'A URL do servidor Evolution não pode conter usuário e senha.'
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Nome de instância seguro para ir no path (o Evolution aceita [\w.-]). */
export function assertInstanceName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(trimmed)) {
    throw new EvolutionError(
      'invalid_config',
      'O nome da instância só pode ter letras, números, ponto, hífen e sublinhado.'
    );
  }
  return trimmed;
}

interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
}

/** Extrai a melhor mensagem de um corpo de erro do Evolution. */
function serverMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const candidates = [
    p.message,
    (p.response as Record<string, unknown> | undefined)?.message,
    p.error,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 300);
    if (Array.isArray(c) && c.length > 0) {
      return c
        .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
        .join('; ')
        .slice(0, 300);
    }
  }
  return null;
}

async function request<T = unknown>(
  creds: EvolutionCreds,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const base = normalizeBaseUrl(creds.baseUrl);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        apikey: creds.apiKey,
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        Accept: 'application/json',
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new EvolutionError(
        'timeout',
        `O servidor Evolution não respondeu em ${Math.round(timeoutMs / 1000)} segundos. Verifique se ele está no ar.`
      );
    }
    throw new EvolutionError(
      'network',
      'Não foi possível conectar ao servidor Evolution. Confira a URL e se o servidor está acessível.'
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const detail = serverMessage(payload);
    if (res.status === 401 || res.status === 403) {
      throw new EvolutionError(
        'unauthorized',
        'A API key foi recusada pelo Evolution. Confira a chave informada.',
        res.status
      );
    }
    if (res.status === 404) {
      throw new EvolutionError(
        'not_found',
        detail
          ? `Evolution: ${detail}`
          : 'Instância não encontrada no servidor Evolution. Confira o nome da instância.',
        res.status
      );
    }
    if (res.status >= 500) {
      throw new EvolutionError(
        'server',
        `O servidor Evolution retornou um erro (${res.status})${detail ? `: ${detail}` : '.'}`,
        res.status
      );
    }
    throw new EvolutionError(
      'bad_request',
      `O Evolution recusou a requisição${detail ? `: ${detail}` : ` (${res.status}).`}`,
      res.status
    );
  }

  return payload as T;
}

// ------------------------------------------------------------
// Instância / conexão
// ------------------------------------------------------------

export interface EvolutionQr {
  /** Data URL `data:image/png;base64,...` pronta para <img src>. */
  qrDataUrl: string | null;
  /** Código de pareamento (alternativa ao QR), quando o servidor devolve. */
  pairingCode: string | null;
}

function asDataUrl(base64: string | undefined | null): string | null {
  if (!base64) return null;
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

/**
 * Pede ao Evolution para (re)iniciar a conexão e devolve o QR. Quando a
 * instância já está conectada o servidor responde sem QR — o chamador
 * confere o estado com `getConnectionState`.
 */
export async function connectInstance(creds: EvolutionCreds): Promise<EvolutionQr> {
  const instance = assertInstanceName(creds.instance);
  const data = await request<{
    base64?: string;
    pairingCode?: string | null;
    qrcode?: { base64?: string; pairingCode?: string | null };
  }>(creds, 'GET', `/instance/connect/${encodeURIComponent(instance)}`);
  return {
    qrDataUrl: asDataUrl(data?.base64 ?? data?.qrcode?.base64),
    pairingCode: data?.pairingCode ?? data?.qrcode?.pairingCode ?? null,
  };
}

export async function getConnectionState(
  creds: EvolutionCreds
): Promise<EvolutionConnectionState> {
  const instance = assertInstanceName(creds.instance);
  const data = await request<{
    instance?: { state?: string };
    state?: string;
  }>(creds, 'GET', `/instance/connectionState/${encodeURIComponent(instance)}`);
  return normalizeState(data?.instance?.state ?? data?.state);
}

export function normalizeState(raw: unknown): EvolutionConnectionState {
  if (raw === 'open') return 'open';
  if (raw === 'connecting') return 'connecting';
  return 'close';
}

/** Número conectado (só dígitos), se o servidor souber. */
export async function fetchConnectedNumber(
  creds: EvolutionCreds
): Promise<string | null> {
  const instance = assertInstanceName(creds.instance);
  const data = await request<unknown>(
    creds,
    'GET',
    `/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`
  );
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== 'object') return null;
  const row = first as Record<string, unknown>;
  const inner = (row.instance ?? {}) as Record<string, unknown>;
  const jid =
    (row.ownerJid as string | undefined) ??
    (inner.owner as string | undefined) ??
    (row.number as string | undefined);
  if (!jid) return null;
  const digits = jid.split('@')[0].replace(/\D/g, '');
  return digits || null;
}

export async function logoutInstance(creds: EvolutionCreds): Promise<void> {
  const instance = assertInstanceName(creds.instance);
  await request(creds, 'DELETE', `/instance/logout/${encodeURIComponent(instance)}`);
}

/**
 * Registra o webhook da instância. O formato do corpo mudou entre as
 * versões do Evolution v2: a partir da 2.2 é `{ webhook: {...} }`; antes,
 * plano. Tenta o aninhado e, se o servidor recusar com 400, o plano.
 */
export async function setWebhook(
  creds: EvolutionCreds,
  webhookUrl: string,
  events: readonly string[] = EVOLUTION_WEBHOOK_EVENTS
): Promise<void> {
  const instance = assertInstanceName(creds.instance);
  const path = `/webhook/set/${encodeURIComponent(instance)}`;
  try {
    await request(creds, 'POST', path, {
      body: {
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: [...events],
        },
      },
    });
  } catch (err) {
    if (err instanceof EvolutionError && err.code === 'bad_request') {
      await request(creds, 'POST', path, {
        body: {
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          webhookBase64: false,
          events: [...events],
        },
      });
      return;
    }
    throw err;
  }
}

// ------------------------------------------------------------
// Envio
// ------------------------------------------------------------

export interface EvolutionSendResult {
  /** `key.id` da mensagem enviada. */
  messageId: string;
}

function extractMessageId(data: unknown): string {
  const id = (data as { key?: { id?: unknown } } | null)?.key?.id;
  if (typeof id !== 'string' || !id) {
    throw new EvolutionError(
      'invalid_response',
      'O Evolution aceitou o envio mas não devolveu o id da mensagem.'
    );
  }
  return id;
}

export interface SendTextArgs {
  /** Dígitos do telefone (ou JID). */
  number: string;
  text: string;
  /** Tempo de "digitando…" exibido ao destinatário antes de chegar. */
  delayMs?: number;
  /** Id (Evolution) da mensagem respondida. */
  quotedMessageId?: string;
}

export async function sendText(
  creds: EvolutionCreds,
  args: SendTextArgs
): Promise<EvolutionSendResult> {
  const instance = assertInstanceName(creds.instance);
  const data = await request(creds, 'POST', `/message/sendText/${encodeURIComponent(instance)}`, {
    body: {
      number: args.number,
      text: args.text,
      ...(args.delayMs ? { delay: args.delayMs } : {}),
      ...(args.quotedMessageId
        ? { quoted: { key: { id: args.quotedMessageId } } }
        : {}),
    },
  });
  return { messageId: extractMessageId(data) };
}

export interface SendMediaArgs {
  number: string;
  mediatype: 'image' | 'video' | 'document';
  /** URL pública ou base64 puro. */
  media: string;
  caption?: string;
  fileName?: string;
  mimetype?: string;
  delayMs?: number;
  quotedMessageId?: string;
}

export async function sendMedia(
  creds: EvolutionCreds,
  args: SendMediaArgs
): Promise<EvolutionSendResult> {
  const instance = assertInstanceName(creds.instance);
  const data = await request(creds, 'POST', `/message/sendMedia/${encodeURIComponent(instance)}`, {
    timeoutMs: MEDIA_TIMEOUT_MS,
    body: {
      number: args.number,
      mediatype: args.mediatype,
      media: args.media,
      ...(args.caption ? { caption: args.caption } : {}),
      ...(args.fileName ? { fileName: args.fileName } : {}),
      ...(args.mimetype ? { mimetype: args.mimetype } : {}),
      ...(args.delayMs ? { delay: args.delayMs } : {}),
      ...(args.quotedMessageId
        ? { quoted: { key: { id: args.quotedMessageId } } }
        : {}),
    },
  });
  return { messageId: extractMessageId(data) };
}

export interface SendAudioArgs {
  number: string;
  /** URL pública ou base64 puro. */
  audio: string;
  delayMs?: number;
  quotedMessageId?: string;
}

/** Nota de voz (PTT): o WhatsApp mostra como gravação de microfone. */
export async function sendAudio(
  creds: EvolutionCreds,
  args: SendAudioArgs
): Promise<EvolutionSendResult> {
  const instance = assertInstanceName(creds.instance);
  const data = await request(
    creds,
    'POST',
    `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`,
    {
      timeoutMs: MEDIA_TIMEOUT_MS,
      body: {
        number: args.number,
        audio: args.audio,
        encoding: true,
        ...(args.delayMs ? { delay: args.delayMs } : {}),
        ...(args.quotedMessageId
          ? { quoted: { key: { id: args.quotedMessageId } } }
          : {}),
      },
    }
  );
  return { messageId: extractMessageId(data) };
}

export interface SendReactionArgs {
  /** JID (ou dígitos) do chat da mensagem reagida. */
  remoteJid: string;
  targetMessageId: string;
  /** `true` se a mensagem reagida foi enviada por nós. */
  fromMe: boolean;
  /** Emoji; vazio remove a reação. */
  emoji: string;
}

export async function sendReaction(
  creds: EvolutionCreds,
  args: SendReactionArgs
): Promise<EvolutionSendResult> {
  const instance = assertInstanceName(creds.instance);
  const data = await request(creds, 'POST', `/message/sendReaction/${encodeURIComponent(instance)}`, {
    body: {
      key: {
        remoteJid: args.remoteJid,
        fromMe: args.fromMe,
        id: args.targetMessageId,
      },
      reaction: args.emoji,
    },
  });
  // A reação devolve a chave da própria reação; se faltar, usa o alvo —
  // o chamador atual ignora o valor.
  const id = (data as { key?: { id?: unknown } } | null)?.key?.id;
  return { messageId: typeof id === 'string' && id ? id : args.targetMessageId };
}

// ------------------------------------------------------------
// Chat
// ------------------------------------------------------------

export async function sendPresence(
  creds: EvolutionCreds,
  args: { number: string; presence?: 'composing' | 'recording' | 'paused'; delayMs?: number }
): Promise<void> {
  const instance = assertInstanceName(creds.instance);
  await request(creds, 'POST', `/chat/sendPresence/${encodeURIComponent(instance)}`, {
    body: {
      number: args.number,
      presence: args.presence ?? 'composing',
      delay: args.delayMs ?? 1200,
    },
  });
}

export async function markAsRead(
  creds: EvolutionCreds,
  args: { remoteJid: string; messageId: string; fromMe?: boolean }
): Promise<void> {
  const instance = assertInstanceName(creds.instance);
  await request(creds, 'POST', `/chat/markMessageAsRead/${encodeURIComponent(instance)}`, {
    body: {
      readMessages: [
        {
          remoteJid: args.remoteJid,
          fromMe: args.fromMe ?? false,
          id: args.messageId,
        },
      ],
    },
  });
}

export interface EvolutionMediaBase64 {
  base64: string;
  mimetype: string | null;
  fileName: string | null;
}

/** Baixa a mídia de uma mensagem recebida, já em base64. */
export async function getMediaBase64(
  creds: EvolutionCreds,
  args: { messageId: string }
): Promise<EvolutionMediaBase64> {
  const instance = assertInstanceName(creds.instance);
  const data = await request<{
    base64?: string;
    mimetype?: string;
    fileName?: string;
  }>(creds, 'POST', `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
    timeoutMs: MEDIA_TIMEOUT_MS,
    body: { message: { key: { id: args.messageId } }, convertToMp4: false },
  });
  if (!data?.base64) {
    throw new EvolutionError(
      'invalid_response',
      'O Evolution não devolveu o conteúdo da mídia.'
    );
  }
  return {
    base64: data.base64.replace(/^data:[^;]+;base64,/, ''),
    mimetype: data.mimetype ?? null,
    fileName: data.fileName ?? null,
  };
}
