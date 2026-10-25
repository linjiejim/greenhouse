/**
 * Lightweight UI preferences shared across screens (theme, language, text size, home's recent count). In-memory store
 * hydrated from persistent storage at startup (SecureStore on native, localStorage on web —
 * same backend as tokens).
 *
 * The language follows the signed-in member's account locale (`/api/auth/me`); this copy is what
 * the app shows before anyone is signed in and while the member loads. The theme is this phone's.
 * The text size is saved here and follows the account where the station keeps it
 * (src/settings/text-size.ts).
 */

import { create } from 'zustand';
import { loadPref, savePref } from '../api/token-storage';
import { DEFAULT_HOME_RECENT, homeRecentOf, type HomeRecent } from '../data/home';
import { DEFAULT_TEXT_STEP, legacyTextStepOf, TEXT_STEPS, textStepOf, type TextStep } from '../theme/type-scale';

export type ThemePref = 'system' | 'light' | 'dark';
export type LangPref = 'zh' | 'en';

interface Prefs {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  lang: LangPref;
  setLang: (l: LangPref) => void;
  /** The in-app text size step (src/theme/type-scale.ts). */
  textStep: TextStep;
  setTextStep: (step: TextStep) => void;
  /** How many recent conversations home lists (this phone's). */
  homeRecent: HomeRecent;
  setHomeRecent: (n: HomeRecent) => void;
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
  textStep: DEFAULT_TEXT_STEP,
  setTextStep: (textStep) => {
    if (get().textStep === textStep) return;
    set({ textStep });
    // the multiplier, not the index: steps may be added anywhere on the ladder
    void savePref('textScale', String(TEXT_STEPS[textStep]));
  },
  homeRecent: DEFAULT_HOME_RECENT,
  setHomeRecent: (homeRecent) => {
    if (get().homeRecent === homeRecent) return;
    set({ homeRecent });
    void savePref('homeRecent', String(homeRecent));
  },
  hydrated: false,
  hydrate: async () => {
    const [theme, lang, textScale, legacyStep, homeRecent] = await Promise.all([
      loadPref('theme'),
      loadPref('lang'),
      loadPref('textScale'),
      loadPref('textStep'),
      loadPref('homeRecent'),
    ]);
    const recent = homeRecentOf(homeRecent);
    const textStep =
      textScale != null ? textStepOf(textScale) : legacyStep != null ? legacyTextStepOf(legacyStep) : null;
    set({
      ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
      ...(lang === 'zh' || lang === 'en' ? { lang } : {}),
      ...(textStep != null ? { textStep } : {}),
      ...(recent !== null ? { homeRecent: recent } : {}),
      hydrated: true,
    });
  },
}));
