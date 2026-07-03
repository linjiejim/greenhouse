/**
 * Lightweight UI preferences shared across screens (theme, language, default
 * agent profile). In-memory store hydrated from persistent storage at startup
 * (SecureStore on native, localStorage on web — same backend as tokens).
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
  /** Agent profile used when starting a new conversation. */
  profileId: string;
  setProfileId: (id: string) => void;
  /** Hydrate persisted prefs once at app start. */
  hydrate: () => Promise<void>;
}

export const usePrefs = create<Prefs>((set) => ({
  theme: 'system',
  setTheme: (theme) => {
    set({ theme });
    void savePref('theme', theme);
  },
  lang: 'zh',
  setLang: (lang) => {
    set({ lang });
    void savePref('lang', lang);
  },
  profileId: 'default',
  setProfileId: (profileId) => {
    set({ profileId });
    void savePref('profile', profileId);
  },
  hydrate: async () => {
    const [theme, lang, profileId] = await Promise.all([
      loadPref('theme'),
      loadPref('lang'),
      loadPref('profile'),
    ]);
    set({
      ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
      ...(lang === 'zh' || lang === 'en' ? { lang } : {}),
      ...(profileId ? { profileId } : {}),
    });
  },
}));
