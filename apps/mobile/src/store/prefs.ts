/**
 * Lightweight UI preferences shared across screens (theme and language). In-memory store
 * hydrated from persistent storage at startup (SecureStore on native, localStorage on web —
 * same backend as tokens).
 *
 * The language follows the signed-in member's account locale (`/api/auth/me`); this copy is what
 * the app shows before anyone is signed in and while the member loads. The theme is this phone's.
 */

import { create } from 'zustand';
import { loadPref, savePref } from '../api/token-storage';

export type ThemePref = 'system' | 'light' | 'dark';
export type LangPref = 'zh' | 'en';

interface Prefs {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  lang: LangPref;
  setLang: (l: LangPref) => void;
  /** Persisted prefs have been read (until then every value is a default). */
  hydrated: boolean;
  /** Hydrate persisted prefs once at app start. */
  hydrate: () => Promise<void>;
}

export const usePrefs = create<Prefs>((set, get) => ({
  theme: 'system',
  setTheme: (theme) => {
    if (get().theme === theme) return;
    set({ theme });
    void savePref('theme', theme);
  },
  lang: 'zh',
  setLang: (lang) => {
    if (get().lang === lang) return;
    set({ lang });
    void savePref('lang', lang);
  },
  hydrated: false,
  hydrate: async () => {
    const [theme, lang] = await Promise.all([loadPref('theme'), loadPref('lang')]);
    set({
      ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
      ...(lang === 'zh' || lang === 'en' ? { lang } : {}),
      hydrated: true,
    });
  },
}));
