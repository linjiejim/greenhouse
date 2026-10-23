/**
 * The app speaks the account's language (`locale` on `/api/auth/me`, changed in Settings and
 * saved with `PUT /api/auth/me/preferences`). Run by the root layout: whenever the signed-in
 * member (re)loads, the app's copy follows; signed out, the app keeps the last one it had.
 */

import { useEffect } from 'react';
import { langOf } from '../api/me';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';

export function useAccountLanguage(): void {
  const locale = useAuth((s) => s.user?.locale);
  const hydrated = usePrefs((s) => s.hydrated);

  useEffect(() => {
    if (!hydrated || !locale) return;
    usePrefs.getState().setLang(langOf(locale));
  }, [hydrated, locale]);
}
