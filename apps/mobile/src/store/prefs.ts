/**
 * Lightweight UI preferences shared across screens (theme, language, the Bots
 * thread to reopen on a cold start and the member's main thread, which details a
 * reply shows). In-memory store hydrated from persistent storage at startup
 * (SecureStore on native, localStorage on web — same backend as tokens).
 */

import { create } from 'zustand';
import { loadPref, savePref } from '../api/token-storage';

export type ThemePref = 'system' | 'light' | 'dark';
export type LangPref = 'zh' | 'en';

/** A Bots thread to open on a cold start — its id and placeholder title, nothing else (D19). */
export interface LastThreadPref {
  c: string;
  title: string;
}

/**
 * The parts of a reply beyond its answer, each shown only when switched on
 * (a conversation's ⋯ menu; global — every chat and Bots thread). All off by
 * default: a reply reads as the answer alone. Off hides the row that opens
 * the sheet, not the data — files, images and cards a tool produced stay.
 */
export interface ReplyDetails {
  /** The reasoning row, and the latest reasoning headline while it thinks. */
  reasoning: boolean;
  /** The tool-pipeline row, and the time / token caption under a reply. */
  tools: boolean;
  /** The references row. */
  sources: boolean;
}

export type ReplyDetail = keyof ReplyDetails;

const DETAILS_OFF: ReplyDetails = { reasoning: false, tools: false, sources: false };

/** Remembered threads kept per map (one per station + account); the oldest go first. */
const LAST_THREADS_MAX = 8;

interface Prefs {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  lang: LangPref;
  setLang: (l: LangPref) => void;
  /** Which reply details are shown (all off by default). */
  details: ReplyDetails;
  setDetail: (detail: ReplyDetail, on: boolean) => void;
  /** Persisted prefs have been read (until then every value is a default). */
  hydrated: boolean;
  /** Last Bots thread per `${stationId}:${userId}` (src/bots/last-surface.ts reads and writes it). */
  lastThreads: Record<string, LastThreadPref>;
  /** Remember (or, with null, forget) the thread for one station + account. */
  setLastThread: (key: string, thread: LastThreadPref | null) => void;
  /**
   * The main thread (Sprouty's DM) per `${stationId}:${userId}`, as the Bots store last knew it — so a
   * cold start can open it before the network answers (src/bots/last-surface.ts reads and writes it).
   */
  mainThreads: Record<string, LastThreadPref>;
  /** Remember (or, with null, forget) the main thread for one station + account. */
  setMainThread: (key: string, thread: LastThreadPref | null) => void;
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
  details: DETAILS_OFF,
  setDetail: (detail, on) => {
    if (get().details[detail] === on) return;
    const details = { ...get().details, [detail]: on };
    set({ details });
    void savePref('details', JSON.stringify(details));
  },
  hydrated: false,
  lastThreads: {},
  setLastThread: (key, thread) => {
    const lastThreads = withThread(get().lastThreads, key, thread);
    if (!lastThreads) return;
    set({ lastThreads });
    void savePref('lastThreads', storedThreads(lastThreads));
  },
  mainThreads: {},
  setMainThread: (key, thread) => {
    const mainThreads = withThread(get().mainThreads, key, thread);
    if (!mainThreads) return;
    set({ mainThreads });
    void savePref('mainThreads', storedThreads(mainThreads));
  },
  hydrate: async () => {
    const [theme, lang, lastThreads, mainThreads, details] = await Promise.all([
      loadPref('theme'),
      loadPref('lang'),
      loadPref('lastThreads'),
      loadPref('mainThreads'),
      loadPref('details'),
    ]);
    set({
      ...(theme === 'light' || theme === 'dark' || theme === 'system' ? { theme } : {}),
      ...(lang === 'zh' || lang === 'en' ? { lang } : {}),
      lastThreads: parseThreads(lastThreads),
      mainThreads: parseThreads(mainThreads),
      details: parseDetails(details),
      hydrated: true,
    });
  },
}));

/**
 * `map` with `key` set to `thread` (re-inserted last = most recent) or dropped (null) — at most
 * `LAST_THREADS_MAX` entries, the oldest go first (SecureStore values are size-capped). null when
 * nothing would change, so a caller can skip the write.
 */
function withThread(
  map: Record<string, LastThreadPref>,
  key: string,
  thread: LastThreadPref | null,
): Record<string, LastThreadPref> | null {
  const known = map[key];
  if (thread ? known?.c === thread.c && known.title === thread.title : !known) return null;
  const { [key]: _previous, ...rest } = map;
  return Object.fromEntries(Object.entries(thread ? { ...rest, [key]: thread } : rest).slice(-LAST_THREADS_MAX));
}

/** What a thread map persists as: its JSON, or null (deleted) when empty. */
function storedThreads(map: Record<string, LastThreadPref>): string | null {
  return Object.keys(map).length ? JSON.stringify(map) : null;
}

/** The stored switches; anything missing or malformed reads as off. */
export function parseDetails(raw: string | null): ReplyDetails {
  if (!raw) return DETAILS_OFF;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ReplyDetail, unknown>> | null;
    if (!parsed || typeof parsed !== 'object') return DETAILS_OFF;
    return {
      reasoning: parsed.reasoning === true,
      tools: parsed.tools === true,
      sources: parsed.sources === true,
    };
  } catch {
    return DETAILS_OFF;
  }
}

/** A stored thread map (`lastThreads` / `mainThreads`), keeping only well-formed entries (a corrupt value reads as empty). */
function parseThreads(raw: string | null): Record<string, LastThreadPref> {
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
