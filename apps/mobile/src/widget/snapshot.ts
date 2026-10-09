/**
 * Publishes the home-screen widget snapshot (schema and rules: ./model.ts) to
 * the App Group via modules/widget-bridge, with the avatar PNGs it points at
 * (./art-host.tsx). The widget never fetches anything itself — the token
 * stays in the app — so it shows what the app last published.
 *
 * Timing (`useWidgetSnapshot`, mounted in app/_layout.tsx):
 * - signed in (startup, sign-in, after a station switch): a refresh — the Bots
 *   lists or, without Bots, recent sessions, plus the agent catalog — then publish;
 * - in the foreground: whenever the Bots store, the default agent or the
 *   language changes, 2 s after it settles (the WebSocket keeps the store live;
 *   reloads triggered from the foreground don't count against WidgetKit's budget);
 * - going to the background: published at once from what the app holds;
 * - signed out, or a station switch starting: cleared (launcher-only) — the
 *   widget never links into the previous station's conversations.
 */

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { pruneWidgetArt, listWidgetArt, setWidgetSnapshot } from '../../modules/widget-bridge';
import { listSessions } from '../api/sessions';
import { botsEnabledNow, isInternal } from '../bots/availability';
import { sproutyBot, useBots, type BotsState } from '../bots/store';
import { cachedProfiles, effectiveProfile, loadProfiles } from '../chat/profile-menu';
import { parseMs } from '../lib/format';
import { t } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useStations } from '../store/stations';
import { renderWidgetArt } from './art-host';
import {
  buildWidgetSnapshot,
  snapshotArtKeys,
  withoutMissingArt,
  type AvatarSource,
  type WidgetInput,
  type WidgetSession,
} from './model';

const IOS = Platform.OS === 'ios';
const SETTLE_MS = 2000;
const MAX_SESSIONS = 4;

/** Recent sessions for the no-Bots layout, as last fetched. */
let sessions: WidgetSession[] = [];
/** Bumped by every publish / clear: an older publish still drawing faces never writes after it. */
let generation = 0;

/** The default agent: the catalog's effective pick, drawn as the Bot it is when we know it. */
function defaultAgent(bots: BotsState): WidgetInput['defaultAgent'] {
  const { lang, profileId } = usePrefs.getState();
  const profile = effectiveProfile(cachedProfiles(), profileId);
  const sprouty = sproutyBot(bots);
  if (!profile) return sprouty ? { name: sprouty.name, avatar: sprouty } : null;
  let bot: (AvatarSource & { name: string }) | null = null;
  if (profile.id === 'sprouty') bot = sprouty;
  else if (profile.id.startsWith('bot:')) bot = bots.byId[profile.id.slice(4).split('@')[0]] ?? null;
  return { name: bot?.name ?? (profile.name_i18n?.[lang] || profile.name), avatar: bot };
}

async function fetchSessions(): Promise<void> {
  const rows = await listSessions({ limit: 10 }).catch(() => null);
  if (!rows) return;
  sessions = rows
    .filter((s) => s.is_owner !== false)
    .slice(0, MAX_SESSIONS)
    .map((s) => {
      const at = parseMs(s.updated_at);
      return { id: s.id, title: s.title || '', updatedAt: Number.isFinite(at) ? at : null };
    });
}

/** Build from what the app holds now, draw the faces it lacks, write. Never throws. */
export async function publishWidgetSnapshot(): Promise<void> {
  const user = useAuth.getState().user;
  if (!IOS || !user || useAuth.getState().loading) return;
  const mine = ++generation;
  try {
    const bots = useBots.getState();
    const { snapshot, jobs } = buildWidgetSnapshot({
      now: Date.now(),
      nickname: user.nickname ?? '',
      lang: usePrefs.getState().lang,
      bots: botsEnabledNow() ? bots : null,
      defaultAgent: defaultAgent(bots),
      sessions,
      copy: {
        deletedBot: t('bots.common.deletedBot'),
        untitledGroup: t('bots.nav.untitledGroup'),
        archivedName: (name) => t('bots.nav.archivedName', { name }),
        youSaid: (text) => t('bots.common.youSaid', { text }),
        botSaid: (name, text) => t('bots.nav.botSaid', { name, text }),
        noMessages: t('bots.common.noMessages'),
      },
      parseMs,
    });
    const have = new Set(listWidgetArt());
    const drawn = await renderWidgetArt(jobs.filter((job) => !have.has(job.key)));
    if (mine !== generation) return;
    const available = new Set([...have, ...drawn]);
    const published = withoutMissingArt(snapshot, available);
    setWidgetSnapshot(JSON.stringify(published));
    pruneWidgetArt(snapshotArtKeys(published));
  } catch {
    // The widget keeps showing the previous snapshot; never surface this to the UI.
  }
}

/** Reload what the widget shows, then publish. */
export async function refreshWidgetSnapshot(): Promise<void> {
  const user = useAuth.getState().user;
  if (!IOS || !user) return;
  const bots = useBots.getState();
  const loads: Promise<unknown>[] = [loadProfiles().catch(() => null)];
  // The Bot list (names, faces, the default agent's) only needs an internal account.
  if (isInternal(user)) loads.push(bots.loadBots());
  if (botsEnabledNow()) loads.push(bots.loadConversations(), bots.loadPending());
  else loads.push(fetchSessions());
  await Promise.all(loads);
  await publishWidgetSnapshot();
}

/** Drop the snapshot and its faces — the widget falls back to launcher-only mode. */
export function clearWidgetSnapshot(): void {
  if (!IOS) return;
  generation += 1;
  sessions = [];
  setWidgetSnapshot(null);
  pruneWidgetArt([]);
}

// A station switch starts: clear before anything of the new station loads. (Not the
// startup hydrate, null → the saved station: that would throw away every rendered face.)
useStations.subscribe((s, prev) => {
  if (prev.activeId && s.activeId !== prev.activeId) clearWidgetSnapshot();
});

/** Keeps the widget in step with the app (see the header for when it publishes). */
export function useWidgetSnapshot(): void {
  const loading = useAuth((s) => s.loading);
  const userId = useAuth((s) => s.user?.id ?? null);

  useEffect(() => {
    if (!IOS || loading) return;
    if (!userId) {
      clearWidgetSnapshot();
      return;
    }
    void refreshWidgetSnapshot();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (AppState.currentState === 'active') void publishWidgetSnapshot();
      }, SETTLE_MS);
    };
    const offBots = useBots.subscribe((s, prev) => {
      if (
        s.conversations !== prev.conversations ||
        s.pendingRequests !== prev.pendingRequests ||
        s.bots !== prev.bots ||
        s.error !== prev.error
      ) {
        settle();
      }
    });
    const offPrefs = usePrefs.subscribe((s, prev) => {
      if (s.lang !== prev.lang || s.profileId !== prev.profileId) settle();
    });
    const offApp = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        if (timer) clearTimeout(timer);
        timer = null;
        void publishWidgetSnapshot();
        if (!botsEnabledNow()) void fetchSessions().then(publishWidgetSnapshot);
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      offBots();
      offPrefs();
      offApp.remove();
    };
  }, [loading, userId]);
}
