'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  QrCode,
  Unplug,
  XCircle,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsPanelHead } from './settings-panel-head';

type EvolutionStatus = 'connected' | 'connecting' | 'disconnected';

interface EvolutionState {
  configured: boolean;
  status: EvolutionStatus | null;
  url: string | null;
  instance: string | null;
  phone: string | null;
  min_interval_ms: number;
  jitter_ms: number;
  broadcast_max: number;
}

const QR_REFRESH_MS = 20_000;
const POLL_MS = 3_000;

export function EvolutionChannel() {
  const t = useTranslations('Settings.evolution');
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [state, setState] = useState<EvolutionState | null>(null);

  const [url, setUrl] = useState('');
  const [instance, setInstance] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [minInterval, setMinInterval] = useState(6);
  const [jitter, setJitter] = useState(4);
  const [broadcastMax, setBroadcastMax] = useState(50);

  const [qrOpen, setQrOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const qrRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/evolution/config', { cache: 'no-store' });
      const data = (await res.json()) as EvolutionState & { error?: string };
      if (!res.ok) throw new Error(data.error);
      setState(data);
      if (data.configured) {
        setUrl(data.url ?? '');
        setInstance(data.instance ?? '');
      }
      setMinInterval(Math.round((data.min_interval_ms ?? 6000) / 1000));
      setJitter(Math.round((data.jitter_ms ?? 4000) / 1000));
      setBroadcastMax(data.broadcast_max ?? 50);
    } catch {
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Enquanto o QR está aberto: renova o código a cada ~20 s (ele expira)
  // e, entre uma renovação e outra, só confere o estado da conexão.
  useEffect(() => {
    if (!qrOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastQrAt = 0;

    const tick = async () => {
      const wantQr = !qrRef.current || Date.now() - lastQrAt > QR_REFRESH_MS;
      try {
        const res = await fetch(
          `/api/whatsapp/evolution/connect${wantQr ? '' : '?qr=0'}`,
          { cache: 'no-store' }
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          toast.error(data.error ?? t('connectFailed'));
          setQrOpen(false);
          return;
        }
        if (data.state === 'open') {
          setQrOpen(false);
          qrRef.current = null;
          setQr(null);
          toast.success(t('connectedToast'));
          void load();
          return;
        }
        if (data.qr) {
          qrRef.current = data.qr;
          lastQrAt = Date.now();
          setQr(data.qr);
          setPairingCode(data.pairingCode ?? null);
        }
      } catch {
        // Falha de rede passageira: tenta de novo no próximo ciclo.
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [qrOpen, load, t]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          instance,
          ...(apiKey ? { api_key: apiKey } : {}),
          min_interval_ms: Math.round(minInterval * 1000),
          jitter_ms: Math.round(jitter * 1000),
          broadcast_max: Math.round(broadcastMax),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      setApiKey('');
      if (data.warning === 'webhook_localhost') toast.warning(t('savedLocalhost'));
      else toast.success(t('saved'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/disconnect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('disconnectFailed'));
        return;
      }
      toast.success(t('disconnectedToast'));
      await load();
    } catch {
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }

  function openQr() {
    qrRef.current = null;
    setQr(null);
    setPairingCode(null);
    setQrOpen(true);
  }

  if (loading) {
    return (
      <section className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-primary" />
      </section>
    );
  }

  const status = state?.configured ? state.status : null;
  const readOnly = !canEditSettings;

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="max-w-2xl space-y-6">
        <Alert className="bg-amber-950/30 border-amber-700/50">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
            <AlertDescription className="text-amber-100/80 text-sm">
              {t('banWarning')}
            </AlertDescription>
          </div>
        </Alert>

        {/* Estado da conexão */}
        <Alert className="bg-card border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {status === 'connected' ? (
                <CheckCircle2 className="size-4 text-primary" />
              ) : status === 'connecting' ? (
                <Loader2 className="size-4 animate-spin text-amber-400" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <div>
                <AlertTitle className="mb-0 text-foreground">
                  {status === 'connected'
                    ? t('statusConnected')
                    : status === 'connecting'
                      ? t('statusConnecting')
                      : status === 'disconnected'
                        ? t('statusDisconnected')
                        : t('statusNotConfigured')}
                </AlertTitle>
                {status === 'connected' && state?.phone && (
                  <AlertDescription className="text-muted-foreground">
                    {t('connectedNumber', { phone: `+${state.phone}` })}
                  </AlertDescription>
                )}
              </div>
            </div>

            {state?.configured && !readOnly && (
              <div className="flex gap-2">
                {status !== 'connected' && (
                  <Button size="sm" onClick={openQr}>
                    <QrCode className="size-4" />
                    {status === 'disconnected' ? t('reconnect') : t('connect')}
                  </Button>
                )}
                {status === 'connected' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Unplug className="size-4" />
                    )}
                    {disconnecting ? t('disconnecting') : t('disconnect')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Alert>

        {/* QR code */}
        {qrOpen && (
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-foreground">{t('qrTitle')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('qrHelp')}</p>
            <div className="mt-4 flex flex-col items-center gap-3">
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qr}
                  alt={t('qrTitle')}
                  className="size-64 rounded-md bg-white p-2"
                />
              ) : (
                <div className="flex size-64 items-center justify-center rounded-md border border-dashed border-border">
                  <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                    {t('qrLoading')}
                  </div>
                </div>
              )}
              {pairingCode && (
                <p className="text-sm text-muted-foreground">
                  {t('pairingCode', { code: pairingCode })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t('qrRenews')}</p>
              <Button size="sm" variant="outline" onClick={() => setQrOpen(false)}>
                {t('close')}
              </Button>
            </div>
          </div>
        )}

        {/* Configuração do servidor */}
        <div className="space-y-4 rounded-lg border border-border bg-card p-5">
          {readOnly && (
            <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
          )}

          <div className="space-y-2">
            <Label htmlFor="evo-url">{t('urlLabel')}</Label>
            <Input
              id="evo-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('urlPlaceholder')}
              disabled={readOnly || saving}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="evo-instance">{t('instanceLabel')}</Label>
            <Input
              id="evo-instance"
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
              placeholder={t('instancePlaceholder')}
              disabled={readOnly || saving}
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="evo-key">{t('apiKeyLabel')}</Label>
            <Input
              id="evo-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={state?.configured ? t('apiKeySaved') : t('apiKeyPlaceholder')}
              disabled={readOnly || saving}
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">{t('apiKeyHint')}</p>
          </div>

          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              {t('advanced')}
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">{t('paceHint')}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="evo-min" className="text-xs">
                  {t('minInterval')}
                </Label>
                <Input
                  id="evo-min"
                  type="number"
                  min={1}
                  max={120}
                  value={minInterval}
                  onChange={(e) => setMinInterval(Number(e.target.value))}
                  disabled={readOnly || saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="evo-jitter" className="text-xs">
                  {t('jitter')}
                </Label>
                <Input
                  id="evo-jitter"
                  type="number"
                  min={0}
                  max={60}
                  value={jitter}
                  onChange={(e) => setJitter(Number(e.target.value))}
                  disabled={readOnly || saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="evo-bmax" className="text-xs">
                  {t('broadcastMax')}
                </Label>
                <Input
                  id="evo-bmax"
                  type="number"
                  min={1}
                  max={1000}
                  value={broadcastMax}
                  onChange={(e) => setBroadcastMax(Number(e.target.value))}
                  disabled={readOnly || saving}
                />
              </div>
            </div>
          </details>

          {!readOnly && (
            <Button
              onClick={handleSave}
              disabled={saving || !url.trim() || !instance.trim()}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? t('saving') : t('save')}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
