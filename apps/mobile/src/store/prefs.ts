/**
 * Lightweight UI preferences shared across screens (theme, language, default
 * agent profile, the Bots thread to reopen on a cold start). In-memory store
 * hydrated from persistent storage at startup (SecureStore on native,
 * localStorage on web — same backend as tokens).
 */

import { create } from 'zustand';
import { loadPref, savePref } from '../api/token-storage';

export type ThemePref = 'system' | 'light' | 'dark';
export type LangPref = 'zh' | 'en';

/** The Bots thread the member left the app on — its id and placeholder title, nothing else (D19). */
export interface LastThreadPref {
  c: string;
  title: string;
}

/** Remembered surfaces kept (one per station + account); the oldest go first. */
const LAST_THREADS_MAX = 8;

interface Prefs {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  lang: LangPref;
  setLang: (l: LangPref) => void;
  /** Agent profile used when starting a new conversation. */
  profileId: string;
  setProfileId: (id: string) => void;
  /** Persisted prefs have been read (until then every value is a default). */
  hydrated: boolean;
  /** Last Bots thread per `${stationId}:${userId}` (src/bots/last-surface.ts reads and writes it). */
  lastThreads: Record<string, LastThreadPref>;
  /** Remember (or, with null, forget) the thread for one station + account. */
  setLastThread: (key: string, thread: LastThreadPref | null) => void;
  /** Hydrate persisted prefs once at app start. */
  hydrate: () => Promise<void>;
}

export const usePrefs = create<Prefs>((set, get) => ({
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
  hydrated: false,
  lastThreads: {},
  setLastThread: (key, thread) => {
    const current = get().lastThreads;
    const known = current[key];
    if (thread ? known?.c === thread.c && known.title === thread.title : !known) return;
    // Re-inserted last = most recent; the map stays small (SecureStore values are size-capped).
    const { [key]: _previous, ...rest } = current;
    const entries = Object.entries(thread ? { ...rest, [key]: thread } : rest).slice(-LAST_THREADS_MAX);
    const lastThreads = Object.fromEntries(entries);
    set({ lastThreads });
    void savePref('lastThreads', entries.length ? JSON.stringify(lastThreads) : null);
  },
  hydrate: async () => {
    const [theme, lang, profileId, lastThreads] = await Promise.all([
      loadPref('theme'),
      loadPref('lang'),
      loadPref('profile'),
      loadPref('lastThreads'),
    ]);
    set({
      ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
      ...(lang === 'zh' || lang === 'en' ? { lang } : {}),
      ...(profileId ? { profileId } : {}),
      lastThreads: parseLastThreads(lastThreads),
      hydrated: true,
    });
  },
}));

/** The stored map, keeping only well-formed entries (a corrupt value reads as empty). */
function parseLastThreads(raw: string | null): Record<string, LastThreadPref> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, LastThreadPref> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<LastThreadPref> | null;
      if (entry && typeof entry.c === 'string' && entry.c && typeof entry.title === 'string') {
        out[key] = { c: entry.c, title: entry.title };
      }
    }
    return out;
  } catch {
    return {};
  }
}
