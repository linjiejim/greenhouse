/**
 * The app speaks the account's language and wears its theme (`me.locale`, `me.theme` — account
 * settings in v2, changed in Settings and saved with `PATCH /api/me`). Run by the root layout:
 * whenever the signed-in member (re)loads, the app's copies follow; signed out, the app keeps
 * the last ones it had.
 */

import { useEffect } from 'react';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import type { LangPref } from '../store/prefs';

/** The account's language as the app's ('zh' unless it says English). */
export const asLang = (locale: string | null | undefined): LangPref => (locale?.startsWith('en') ? 'en' : 'zh');

export function useAccountLanguage(): void {
  const locale = useAuth((s) => s.user?.locale);
  const theme = useAuth((s) => s.user?.theme);
  const hydrated = usePrefs((s) => s.hydrated);

  useEffect(() => {
    if (!hydrated || !locale) return;
    usePrefs.getState().setLang(asLang(locale));
  }, [hydrated, locale]);

  useEffect(() => {
    if (!hydrated || !theme) return;
    usePrefs.getState().setTheme(theme);
  }, [hydrated, theme]);
}
