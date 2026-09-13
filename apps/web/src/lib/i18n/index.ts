/**
 * i18n — lightweight internationalization for the web app.
 *
 * Architecture:
 * - Locale files: en.ts, zh.ts (flat namespace objects)
 * - React context provides `t()` helper + current locale
 * - Persisted to localStorage (`app-locale`) and synced to user preferences via API
 * - Default: 'en', switchable from the Settings page
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import type { LocalizedText } from '@greenhouse/types/api';
import en from './en';
import zh from './zh';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Locale = 'en' | 'zh';
export type LocaleMessages = typeof en;

/** Dot-notation path into the messages object, e.g. "chat.newConversation" */
type FlatKeys<T, Prefix extends string = ''> =
  T extends Record<string, unknown>
    ? {
        [K in keyof T & string]: T[K] extends Record<string, unknown>
          ? FlatKeys<T[K], `${Prefix}${K}.`>
          : `${Prefix}${K}`;
      }[keyof T & string]
    : never;

export type TranslationKey = FlatKeys<LocaleMessages>;

// ---------------------------------------------------------------------------
// Locale registry
// ---------------------------------------------------------------------------

const locales: Record<Locale, LocaleMessages> = { en, zh: zh as unknown as LocaleMessages };

export const LOCALE_OPTIONS: Array<{ value: Locale; label: string; nativeLabel: string }> = [
  { value: 'en', label: 'English', nativeLabel: 'English' },
  { value: 'zh', label: 'Chinese (Simplified)', nativeLabel: '简体中文' },
];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'app-locale';

export function getStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'zh') return v;
  } catch (_err) {
    // SSR or access denied
  }
  return 'en';
}

function storeLocale(locale: Locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch (_err) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Translation helper (non-React usage)
// ---------------------------------------------------------------------------

function resolve(messages: LocaleMessages, key: string): string {
  const parts = key.split('.');
  let current: unknown = messages;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return key; // fallback to key itself
    }
  }
  return typeof current === 'string' ? current : key;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

/** Translate outside React (native bridges, registries, and other imperative code). */
export function translate(locale: Locale, key: TranslationKey, params?: Record<string, string | number>): string {
  const messages = locales[locale] ?? locales.en;
  return interpolate(resolve(messages, key), params);
}

// ---------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key, params) => translate('en', key, params),
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface I18nProviderProps {
  children: React.ReactNode;
  /** Optional initial locale override (e.g. from user profile) */
  initialLocale?: Locale;
  /** Called when user changes locale — persist to backend */
  onLocaleChange?: (locale: Locale) => void;
}

export function I18nProvider({ children, initialLocale, onLocaleChange }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? getStoredLocale());

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      storeLocale(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );

  // Sync if initialLocale changes (e.g. after login fetches user prefs)
  useEffect(() => {
    if (initialLocale && initialLocale !== locale) {
      setLocaleState(initialLocale);
      storeLocale(initialLocale);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLocale]);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string => translate(locale, key, params),
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return React.createElement(I18nContext.Provider, { value }, children);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useI18n() {
  return useContext(I18nContext);
}

/** Shorthand — just the t() function */
export function useT() {
  return useContext(I18nContext).t;
}

// ---------------------------------------------------------------------------
// Server-authored copy (LocalizedText)
// ---------------------------------------------------------------------------
//
// Some display text comes from the backend rather than the locale files — system
// profile names, descriptions, capability cards, model choice labels. Those ship
// as a `{ zh, en }` map alongside the flat field. User-authored content (custom
// profiles) has no map, so the flat field is always the last fallback.

/** Locale the backend YAML profiles are authored in. */
const SOURCE_LOCALE: Locale = 'zh';

/**
 * Resolve server-authored copy for a locale.
 * Fallback chain: requested locale → source locale → flat field.
 */
export function pickLocalized(value: LocalizedText | undefined | null, fallback: string, locale: Locale): string {
  return value?.[locale] || value?.[SOURCE_LOCALE] || fallback;
}

/** Hook form of {@link pickLocalized}, bound to the current locale. */
export function useLocalized() {
  const { locale } = useI18n();
  return useCallback(
    (value: LocalizedText | undefined | null, fallback: string) => pickLocalized(value, fallback, locale),
    [locale],
  );
}
