/**
 * The account's language — what the server writes in: Bot greetings, event
 * lines, cards, notifications — kept in step with the app's.
 *
 *  - The member picks a language in Settings → `chooseLanguage`: the app
 *    switches and the account takes it as the member's pick (the web's
 *    language switch does the same).
 *  - Otherwise, while the account's language is still the default
 *    (`locale_chosen: false` — a server too old to say so is left alone), the
 *    app's language (中文 out of the box) is offered once per sign-in as
 *    `inferred` (`useAccountLanguage`, run by the root layout once prefs are
 *    loaded). The server takes it only while nobody picked one, so a pick
 *    made on the web is never undone by the app's default.
 *
 * Either way the server re-words Sprouty's untouched built-in role and
 * instructions in the new language.
 */

import { useEffect } from 'react';
import { saveAccountLocale } from '../api/auth';
import { useAuth } from '../store/auth';
import { usePrefs, type LangPref } from '../store/prefs';
import { useStations } from '../store/stations';

/** `station:user:lang` already offered in this run — once per sign-in, not on every render. */
const offered = new Set<string>();

/** Settings' language menu: switch the app, and make it the account's language. */
export function chooseLanguage(lang: LangPref): void {
  usePrefs.getState().setLang(lang);
  const userId = useAuth.getState().user?.id;
  void saveAccountLocale(lang).then((saved) => {
    if (saved && userId) keepUserLocale(userId, saved);
  });
}

/** Offer the app's language to an account that has another one (root layout). */
export function useAccountLanguage(): void {
  const user = useAuth((s) => s.user);
  const hydrated = usePrefs((s) => s.hydrated);
  const lang = usePrefs((s) => s.lang);
  const station = useStations((s) => s.activeId);

  useEffect(() => {
    if (!user || !hydrated || user.locale_chosen !== false || user.locale === lang) return;
    const key = `${station}:${user.id}:${lang}`;
    if (offered.has(key)) return;
    offered.add(key);
    void saveAccountLocale(lang, { inferred: true }).then((saved) => {
      if (saved) keepUserLocale(user.id, saved);
    });
  }, [user, hydrated, lang, station]);
}

/** The signed-in user's language as the server now has it — unless someone else signed in meanwhile. */
function keepUserLocale(userId: string, saved: { locale: string; chosen: boolean }): void {
  const { user, setUser } = useAuth.getState();
  if (user?.id !== userId || (user.locale === saved.locale && user.locale_chosen === saved.chosen)) return;
  setUser({ ...user, locale: saved.locale, locale_chosen: saved.chosen });
}
