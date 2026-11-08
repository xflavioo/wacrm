'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { WhatsAppConfig } from './whatsapp-config';
import { EvolutionChannel } from './evolution-channel';

type Channel = 'meta' | 'evolution';

/**
 * Escolha do canal do WhatsApp (Settings → WhatsApp): API oficial da
 * Meta ou QR code via Evolution. O painel da Meta (`WhatsAppConfig`) é
 * renderizado intacto; este wrapper só decide qual painel aparece.
 *
 * O canal ativo é o do banco (`whatsapp_config.provider`): trocar a aba
 * só muda a tela, quem troca o canal é SALVAR no painel escolhido — o
 * servidor reescreve a mesma linha (um provedor por conta).
 */
export function WhatsAppChannelSettings() {
  const t = useTranslations('Settings.whatsappChannel');
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/evolution/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setChannel(d?.provider === 'evolution' ? 'evolution' : 'meta');
      })
      // Banco sem as migrações 040/041 (ou falha de rede): comporta-se
      // exatamente como antes, só com o painel da Meta.
      .catch(() => {
        if (!cancelled) setChannel('meta');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (channel === null) {
    return (
      <section className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-primary" />
      </section>
    );
  }

  const options: { id: Channel; title: string; desc: string }[] = [
    { id: 'meta', title: t('meta'), desc: t('metaDesc') },
    { id: 'evolution', title: t('evolution'), desc: t('evolutionDesc') },
  ];

  return (
    <div>
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <div role="radiogroup" aria-label={t('title')} className="mt-2 grid gap-3 sm:grid-cols-2">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={channel === o.id}
              onClick={() => setChannel(o.id)}
              className={cn(
                'rounded-lg border p-4 text-left transition-colors',
                channel === o.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:bg-muted/50'
              )}
            >
              <div className="text-sm font-medium text-foreground">{o.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{o.desc}</div>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('oneAtATime')}</p>
      </div>

      {channel === 'evolution' ? <EvolutionChannel /> : <WhatsAppConfig />}
    </div>
  );
}
