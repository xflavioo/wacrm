'use client';

import { useTranslations } from 'next-intl';
import { LayoutTemplate } from 'lucide-react';

import { useWhatsAppChannel } from '@/hooks/use-whatsapp-channel';
import { SettingsPanelHead } from './settings-panel-head';
import { TemplateManager } from './template-manager';

/**
 * Modelos (templates), sincronização com a Meta e verificação dependem do
 * WABA, que o canal QR code não tem. Nesse canal a tela vira um aviso;
 * na API oficial é o `TemplateManager` de sempre.
 */
export function TemplatesPanel() {
  const t = useTranslations('Settings.evolution');
  const { isQr } = useWhatsAppChannel();

  if (!isQr) return <TemplateManager />;

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('templatesTitle')} description="" />
      <div className="flex max-w-2xl items-start gap-3 rounded-lg border border-border bg-card p-5">
        <LayoutTemplate className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('templatesBody')}</p>
      </div>
    </section>
  );
}
