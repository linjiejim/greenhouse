/**
 * The agent catalog's one home (GET /api/profiles) — what the home-screen
 * widget draws when it doesn't know the member's Sprouty yet:
 * `loadProfiles()` / `cachedProfiles()` (cached per app run) and
 * `effectiveProfile()` (which agent a new conversation will actually get).
 *
 * Nothing picks an agent any more (2026-10): a new chat starts with Sprouty,
 * and a chat with one Bot starts from that Bot — the drawer, its profile,
 * "New Chat" in its thread (`?profile=`).
 */

import { listProfiles, type Profile } from '../api/sessions';
import type { LangPref } from '../store/prefs';

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

/**
 * GET /api/profiles also carries per-locale names for system agents (custom
 * agents never do) — canonical `Profile.name_i18n` in packages/types.
 */
export type LocalizedProfile = Profile & { name_i18n?: Partial<Record<LangPref, string>> };

/** Server's default agent (legacy ids like `default` / `team` normalize to it). */
const SERVER_DEFAULT_PROFILE = 'sprouty';

/**
 * The agent a new conversation asking for `profileId` will actually get: it
 * when it's in the catalog, otherwise the server default (mirrors the API's
 * `normalizeProfileId`), otherwise the first agent.
 */
export function effectiveProfile<P extends Profile>(rows: P[] | null, profileId: string): P | null {
  if (!rows?.length) return null;
  return rows.find((p) => p.id === profileId) ?? rows.find((p) => p.id === SERVER_DEFAULT_PROFILE) ?? rows[0];
}
