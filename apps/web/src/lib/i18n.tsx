/**
 * The dictionary: every string on screen comes from src/i18n (zh is the source; en must have
 * the same keys). `{name}` in a string is filled from vars.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { en } from '../i18n/en';
import { zh, type MessageKey } from '../i18n/zh';

export type Locale = 'zh' | 'en';
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { zh, en };

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? zh[key] ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match)) : template;
}

/** The browser's language until the member's own setting is known. */
export function browserLocale(): Locale {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const asLocale = (value: string | null | undefined): Locale => (value === 'en' ? 'en' : 'zh');

const I18nContext = createContext<{ locale: Locale; t: Translate }>({
  locale: 'zh',
  t: (key, vars) => translate('zh', key, vars),
});

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: ((key, vars) => translate(locale, key, vars)) as Translate }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
export const useT = () => useContext(I18nContext).t;
