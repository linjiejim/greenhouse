/**
 * The agent catalog's one home (GET /api/profiles) — for Settings' default
 * agent picker and whatever a new conversation will get: `useProfiles()`
 * (cached per app run, refreshed in the background whenever a picker mounts),
 * `effectiveProfile()` (which agent a new conversation will actually get) and
 * `profileLabel()` (the localized name, marked when it's a custom agent; with
 * Bots on the member's Bots read "Name · Bot").
 *
 * There is no picker above the composer any more (2026-10-09): a new chat takes
 * the default from Settings (prefs `profileId`, bound to the next session
 * created), and a chat with one Bot starts from that Bot — the drawer, its
 * profile, "New Chat" in its thread (`?profile=`).
 */

import { useEffect, useState } from 'react';
import { listProfiles, type Profile } from '../api/sessions';
import type { LangPref } from '../store/prefs';
import type { useT } from '../lib/i18n';

let cache: LocalizedProfile[] | null = null;
let inflight: Promise<LocalizedProfile[]> | null = null;

function fetchProfiles(): Promise<LocalizedProfile[]> {
  inflight ??= listProfiles()
    .then((rows) => {
      cache = rows;
      return rows;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The agent catalog without a component (the widget snapshot): fresh from the server. */
export function loadProfiles(): Promise<LocalizedProfile[]> {
  return fetchProfiles();
}

/** The catalog as last fetched in this app run, or null. */
export function cachedProfiles(): LocalizedProfile[] | null {
  return cache;
}

/** The agent catalog (cached; refetched once per mount). */
export function useProfiles(): LocalizedProfile[] | null {
  const [rows, setRows] = useState<LocalizedProfile[] | null>(cache);
  useEffect(() => {
    let alive = true;
    void fetchProfiles().then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, []);
  return rows;
}

/**
 * GET /api/profiles also carries per-locale names for system agents (custom
 * agents never do) — canonical `Profile.name_i18n` in packages/types.
 */
export type LocalizedProfile = Profile & { name_i18n?: Partial<Record<LangPref, string>> };

/** Server's default agent (legacy ids like `default` / `team` normalize to it). */
const SERVER_DEFAULT_PROFILE = 'sprouty';

/**
 * The agent a new conversation will actually get: the stored pick when it's
 * in the catalog, otherwise the server default (mirrors the API's
 * `normalizeProfileId` — the stored id may be the unset `default` or stale,
 * picked on another station), otherwise the first agent.
 */
export function effectiveProfile<P extends Profile>(rows: P[] | null, profileId: string): P | null {
  if (!rows?.length) return null;
  return rows.find((p) => p.id === profileId) ?? rows.find((p) => p.id === SERVER_DEFAULT_PROFILE) ?? rows[0];
}

/** A member's Bot in the catalog: the built-in Sprouty or `bot:<id>`. */
function isBotProfile(id: string): boolean {
  return id === SERVER_DEFAULT_PROFILE || id.startsWith('bot:');
}

/**
 * The agent's display name in `lang`, marked " · 自定义" for a custom agent —
 * or, with `bots` (Bots on), " · Bot" for the member's Bots.
 */
export function profileLabel(p: LocalizedProfile, lang: LangPref, t: ReturnType<typeof useT>, bots = false): string {
  const name = p.name_i18n?.[lang] || p.name;
  if (bots && isBotProfile(p.id)) return `${name} · ${t('bots.nav.botSuffix')}`;
  return p.is_custom ? `${name} · ${t('profile.custom')}` : name;
}
