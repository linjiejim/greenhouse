/**
 * Tiny local i18n — the mobile app can't import @greenhouse/ui (workspace
 * isolation), so this mirrors its useT() pattern in ~40 lines. Keys are
 * dot-paths into the en/zh catalogs ('login.submit'); en is the type source
 * and the fallback. `{n}` placeholders interpolate via the second arg.
 */

import { usePrefs, type LangPref } from '../../store/prefs';
import { en, type Catalog } from './en';
import { zh } from './zh';

const catalogs: Record<LangPref, Catalog> = { en, zh };

type FlatKeys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : FlatKeys<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TranslationKey = FlatKeys<Catalog>;

function lookup(cat: Catalog, key: string): string | undefined {
  let cur: unknown = cat;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function translate(lang: LangPref, key: TranslationKey, vars?: Record<string, string | number>): string {
  const raw = lookup(catalogs[lang], key) ?? lookup(en, key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/** Hook: returns t() bound to the current language preference. */
export function useT(): (key: TranslationKey, vars?: Record<string, string | number>) => string {
  const lang = usePrefs((s) => s.lang);
  return (key, vars) => translate(lang, key, vars);
}

/** Non-hook accessor for helpers outside React (reads the store directly). */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return translate(usePrefs.getState().lang, key, vars);
}
