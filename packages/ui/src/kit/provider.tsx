/**
 * KitProvider chooses the language of the kit's own words (strings.ts). Theme is not a
 * provider concern: tokens switch on `data-theme` and the narrow layout on `data-narrow`,
 * both set by the app shell on <html> (or by a preview on its frame).
 */

import { createContext, useContext, type ReactNode } from 'react';
import { kitStrings, type KitLocale, type KitStrings } from './strings';

const LocaleContext = createContext<KitLocale>('zh');

export function KitProvider({ locale = 'zh', children }: { locale?: KitLocale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useKitLocale(): KitLocale {
  return useContext(LocaleContext);
}

export function useKitStrings(): KitStrings {
  return kitStrings[useContext(LocaleContext)];
}

/** Joins the class names that are set. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
