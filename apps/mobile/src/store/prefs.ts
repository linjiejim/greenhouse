/**
 * Lightweight UI preferences shared across screens (theme, language, and the member's main
 * thread per station). In-memory store hydrated from persistent storage at startup (SecureStore
 * on native, localStorage on web — same backend as tokens).
 *
 * Theme and language follow the signed-in member's account (`/api/me`: they are account
 * settings in v2); these copies are what the app shows before anyone is signed in and while
 * the member loads.
 */

import { create } from 'zustand';
import { loadPref, savePref } from '../api/token-storage';

export type ThemePref = 'system' | 'light' | 'dark';
export type LangPref = 'zh' | 'en';

/** The main thread of one station + member: its id and title, nothing else (no transcript on disk). */
export interface MainThreadPref {
  c: string;
  title: string;
}

/** Remembered main threads (one per station + member); the oldest go first. */
const MAIN_THREADS_MAX = 8;

interface Prefs {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  lang: LangPref;
  setLang: (l: LangPref) => void;
  /** Persisted prefs have been read (until then every value is a default). */
  hydrated: boolean;
  /**
   * The main thread per `${stationId}:${userId}`, as the directory last knew it — so a cold start
   * opens it before the network answers (src/shell/main-thread.ts reads and writes it).
   */
  mainThreads: Record<string, MainThreadPref>;
  /** Remember (or, with null, forget) the main thread for one station + member. */
  setMainThread: (key: string, thread: MainThreadPref | null) => void;
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
  mainThreads: {},
  setMainThread: (key, thread) => {
    const known = get().mainThreads[key];
    if (thread ? known?.c === thread.c && known.title === thread.title : !known) return;
    const { [key]: _previous, ...rest } = get().mainThreads;
    const mainThreads = Object.fromEntries(
      Object.entries(thread ? { ...rest, [key]: thread } : rest).slice(-MAIN_THREADS_MAX),
    );
    set({ mainThreads });
    void savePref('mainThreads', Object.keys(mainThreads).length ? JSON.stringify(mainThreads) : null);
  },
  hydrate: async () => {
    const [theme, lang, mainThreads] = await Promise.all([loadPref('theme'), loadPref('lang'), loadPref('mainThreads')]);
    set({
      ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
      ...(lang === 'zh' || lang === 'en' ? { lang } : {}),
      mainThreads: parseThreads(mainThreads),
      hydrated: true,
    });
  },
}));

/** A stored thread map, keeping only well-formed entries (a corrupt value reads as empty). */
function parseThreads(raw: string | null): Record<string, MainThreadPref> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, MainThreadPref> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<MainThreadPref> | null;
      if (entry && typeof entry.c === 'string' && entry.c && typeof entry.title === 'string') {
        out[key] = { c: entry.c, title: entry.title };
      }
    }
    return out;
  } catch {
    return {};
  }
}
