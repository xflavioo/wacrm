'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import {
  FREE_TEXT_TEMPLATE_NAME,
  useBroadcastSending,
} from '@/hooks/use-broadcast-sending';
import { useWhatsAppChannel } from '@/hooks/use-whatsapp-channel';
import type { MessageTemplate } from '@/types';

type MediaKind = 'image' | 'video' | 'document';

const STEPS = ['stepMessage', 'stepAudience', 'stepSend'] as const;

/**
 * Wizard de disparo do canal QR code (Evolution). Não há templates: o
 * disparo é uma mensagem livre (texto, com mídia opcional), enviada
 * devagar e um a um pelo servidor. Reaproveita a etapa de público e o
 * mesmo `useBroadcastSending` do wizard da Meta.
 */
export function QrBroadcastWizard() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.qr');
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();
  const { broadcastMax } = useWhatsAppChannel();

  const [step, setStep] = useState(0);
  const [text, setText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaKind, setMediaKind] = useState<MediaKind>('image');
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });

  const hasMessage = text.trim().length > 0 || mediaUrl.trim().length > 0;

  async function handleSend() {
    if (!name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    // O hook exige um MessageTemplate; aqui é só o marcador do disparo livre.
    const placeholder = {
      name: FREE_TEXT_TEMPLATE_NAME,
      language: 'pt_BR',
    } as unknown as MessageTemplate;
    try {
      const id = await createAndSendBroadcast({
        name: name.trim(),
        template: placeholder,
        audience,
        variables: {},
        freeMessage: {
          text: text.trim(),
          ...(mediaUrl.trim() ? { mediaUrl: mediaUrl.trim(), mediaKind } : {}),
        },
        maxRecipients: broadcastMax,
      });
      router.push(`/broadcasts/${id}`);
    } catch (err) {
      console.error('Broadcast failed:', err);
      toast.error(err instanceof Error ? err.message : t('failed'));
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Alert className="bg-amber-950/30 border-amber-700/50">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div>
            <AlertTitle className="text-amber-200">{t('banTitle')}</AlertTitle>
            <AlertDescription className="text-amber-100/80 text-sm">
              {t('banBody')}
            </AlertDescription>
          </div>
        </div>
      </Alert>

      {/* Indicador de etapas */}
      <div className="flex items-center justify-between">
        {STEPS.map((key, index) => {
          const active = index === step;
          const done = index < step;
          return (
            <div key={key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
                    done
                      ? 'bg-primary text-primary-foreground'
                      : active
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {done ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    active ? 'text-foreground' : done ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(key)}
                </span>
              </div>
              {index < STEPS.length - 1 && (
                <div className={`mx-3 h-px flex-1 ${done ? 'bg-primary' : 'bg-muted'}`} />
              )}
            </div>
          );
        })}
      </div>

      <div
        className="min-h-[300px] transition-opacity"
        style={{ opacity: isProcessing ? 0.6 : 1, pointerEvents: isProcessing ? 'none' : 'auto' }}
      >
        {step === 0 && (
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="qr-text">{t('messageLabel')}</Label>
              <Textarea
                id="qr-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t.raw('messagePlaceholder')}
                rows={6}
                maxLength={4096}
              />
              <p className="text-xs text-muted-foreground">{t.raw('variablesHint')}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
              <div className="space-y-2">
                <Label htmlFor="qr-media">{t('mediaLabel')}</Label>
                <Input
                  id="qr-media"
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  placeholder={t('mediaPlaceholder')}
                  inputMode="url"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qr-kind">{t('mediaKindLabel')}</Label>
                <select
                  id="qr-kind"
                  value={mediaKind}
                  onChange={(e) => setMediaKind(e.target.value as MediaKind)}
                  disabled={!mediaUrl.trim()}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                >
                  <option value="image">{t('kindImage')}</option>
                  <option value="video">{t('kindVideo')}</option>
                  <option value="document">{t('kindDocument')}</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('mediaHint')}</p>

            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => router.push('/broadcasts')}>
                {t('back')}
              </Button>
              <Button
                disabled={!hasMessage}
                onClick={() => (hasMessage ? setStep(1) : toast.error(t('messageRequired')))}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <Step2SelectAudience
            audience={audience}
            onUpdate={setAudience}
            onNext={() => setStep(2)}
            onBack={() => setStep(0)}
          />
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="qr-name">{t('nameLabel')}</Label>
              <Input
                id="qr-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
              />
            </div>

            <div className="rounded-lg border border-border bg-card p-4 text-sm">
              <p className="whitespace-pre-wrap text-foreground">{text || mediaUrl}</p>
            </div>

            <p className="text-xs text-muted-foreground">{t('limitInfo', { max: broadcastMax })}</p>
            <p className="text-xs text-muted-foreground">{t('paceInfo', { seconds: 8 })}</p>

            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep(1)} disabled={isProcessing}>
                {t('back')}
              </Button>
              <Button onClick={handleSend} disabled={isProcessing || !name.trim()}>
                {isProcessing && <Loader2 className="size-4 animate-spin" />}
                {isProcessing ? t('sending', { progress }) : t('send')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
