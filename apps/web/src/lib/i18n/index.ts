/**
 * i18n — lightweight internationalization for the web app.
 *
 * Architecture:
 * - Locale files: en.ts, zh.ts (flat namespace objects)
 * - React context provides `t()` helper + current locale
 * - Persisted to localStorage (`app-locale`) and synced to user preferences via API
 * - Default: 'en', switchable in Preferences dialog
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
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

// ─── Fork extension point (locale messages) ──────────────
// @greenhouse i18n key parity is TS-enforced on the core en/zh objects. A
// downstream fork registers its private-module translations at startup via
// registerLocaleMessages(locale, namespaceObject); t() falls back to these when a
// key misses the core messages (then to en, then to the key itself). Empty
// upstream. Fork keys are plain strings — not in the core TranslationKey union.
const extensionMessages: Partial<Record<Locale, Record<string, unknown>>> = {};

/** Register private-module translations contributed by a downstream fork. */
export function registerLocaleMessages(locale: Locale, messages: Record<string, unknown>): void {
  extensionMessages[locale] = { ...(extensionMessages[locale] ?? {}), ...messages };
}

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

function resolve(messages: Record<string, unknown>, key: string): string {
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

/** Resolve a key against core messages, then fork extension messages (this
 *  locale → en), then the key itself. Empty extensions upstream ⇒ core only. */
function resolveKey(locale: Locale, key: string): string {
  const core = resolve(locales[locale] ?? locales.en, key);
  if (core !== key) return core;
  const ext = extensionMessages[locale];
  if (ext) {
    const r = resolve(ext, key);
    if (r !== key) return r;
  }
  if (locale !== 'en' && extensionMessages.en) {
    const r = resolve(extensionMessages.en, key);
    if (r !== key) return r;
  }
  return key;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

// ---------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  // Core keys keep autocomplete; `(string & {})` lets a fork pass its own
  // registered keys (see registerLocaleMessages).
  t: (key: TranslationKey | (string & {}), params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key) => key,
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

  const t = useCallback(
    (key: TranslationKey | (string & {}), params?: Record<string, string | number>): string => {
      const raw = resolveKey(locale, key);
      return interpolate(raw, params);
    },
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
