// ============================================================
// Locale da interface para formatação de datas e números.
//
// `NEXT_PUBLIC_APP_LOCALE` escolhe o dicionário do next-intl
// (src/i18n/request.ts). Este módulo deriva dele o que o next-intl não
// cobre: o locale do `Intl` e o locale do date-fns, para que datas,
// "há 5 minutos" e moeda acompanhem o idioma da interface.
//
// Para `en` (o padrão) nada muda: `INTL_LOCALE` fica `undefined`, ou
// seja, o `Intl` continua usando o locale do navegador como antes.
// ============================================================

import { ptBR } from 'date-fns/locale/pt-BR';
import type { Locale } from 'date-fns';

export const APP_LOCALE = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';

const IS_PT = APP_LOCALE === 'pt' || APP_LOCALE === 'pt-BR';

/** Argumento de locale para `Intl.*` / `toLocale*String`. */
export const INTL_LOCALE: string | undefined = IS_PT
  ? 'pt-BR'
  : APP_LOCALE === 'ko'
    ? 'ko-KR'
    : /^[a-z]{2}-[A-Z]{2}$/.test(APP_LOCALE)
      ? APP_LOCALE // an explicit BCP-47 tag (the test suite pins en-US)
      : undefined;

/** Opção `{ locale }` para o date-fns (`format`, `formatDistanceToNow`…). */
export const DATE_FNS_LOCALE: Locale | undefined = IS_PT ? ptBR : undefined;

/** Moeda padrão quando a conta não definiu uma: BRL no Brasil. */
export const LOCALE_DEFAULT_CURRENCY = IS_PT ? 'BRL' : 'USD';

/** Padrão de data longa do date-fns ("January 5, 2026" / "5 de janeiro de 2026"). */
export const LONG_DATE_PATTERN = IS_PT ? "d 'de' MMMM 'de' yyyy" : 'MMMM d, yyyy';

/** Data curta com hora ("Jan 5, 2026 14:30" / "5 de jan. de 2026 14:30"). */
export const SHORT_DATETIME_PATTERN = IS_PT
  ? "d 'de' MMM 'de' yyyy HH:mm"
  : 'MMM d, yyyy HH:mm';

/** Dia e mês curtos para eixos de gráfico ("Jan 5" / "5 de jan."). */
export const DAY_MONTH_PATTERN = IS_PT ? "d 'de' MMM" : 'MMM d';
