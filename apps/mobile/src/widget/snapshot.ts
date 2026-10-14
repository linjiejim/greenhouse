/**
 * Publishes the home-screen widget snapshot (schema and rules: ./model.ts) to
 * the App Group via modules/widget-bridge, with the avatar PNGs it points at
 * (./art-host.tsx). The widget never fetches anything itself — the token
 * stays in the app — so it shows what the app last published.
 *
 * Timing (`useWidgetSnapshot`, mounted in app/_layout.tsx):
 * - signed in (startup, sign-in, after a station switch): the pending cards are
 *   listed, then it publishes from the workspace (src/store/workspace.ts — the
 *   drawer and the realtime socket keep it current);
 * - in the foreground: whenever the Agents, the conversations, the bell's count or
 *   the language change, 2 s after they settle (reloads triggered from the
 *   foreground don't count against WidgetKit's budget);
 * - going to the background: published at once from what the app holds;
 * - signed out, or a station switch starting: cleared (launcher-only) — the
 *   widget never links into the previous station's conversations.
 */

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { pruneWidgetArt, listWidgetArt, setWidgetSnapshot } from '../../modules/widget-bridge';
import { listRequests } from '../api/requests';
import { parseMs } from '../data/time';
import type { NeedsYou } from '../shared/contract';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useStations } from '../store/stations';
import { useWorkspace } from '../store/workspace';
import { renderWidgetArt } from './art-host';
import { buildWidgetSnapshot, snapshotArtKeys, withoutMissingArt } from './model';

const IOS = Platform.OS === 'ios';
const SETTLE_MS = 2000;

/** The pending cards, as last listed (for the card a face opens and its title). */
let pending: NeedsYou[] = [];
/** Bumped by every publish / clear: an older publish still drawing faces never writes after it. */
let generation = 0;

async function fetchPending(): Promise<void> {
  if ((useWorkspace.getState().summary?.needs_you ?? 0) === 0) {
    pending = [];
    return;
  }
  const page = await listRequests({ state: 'pending', limit: 50 });
  if (page.ok) pending = page.data.items;
}

/** Build from what the app holds now, draw the faces it lacks, write. Never throws. */
export async function publishWidgetSnapshot(): Promise<void> {
  const user = useAuth.getState().user;
  if (!IOS || !user || useAuth.getState().loading) return;
  const mine = ++generation;
  try {
    const { agents, conversations } = useWorkspace.getState();
    const { snapshot, jobs } = buildWidgetSnapshot({
      now: Date.now(),
      nickname: user.name,
      lang: usePrefs.getState().lang,
      source: agents ? { agents, conversations: conversations ?? [], requests: pending } : null,
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

/** Drop the snapshot and its faces — the widget falls back to launcher-only mode. */
export function clearWidgetSnapshot(): void {
  if (!IOS) return;
  generation += 1;
  pending = [];
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
    void fetchPending().then(publishWidgetSnapshot);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cardsChanged = false;
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (AppState.currentState !== 'active') return;
        const listed = cardsChanged ? fetchPending() : Promise.resolve();
        cardsChanged = false;
        void listed.then(publishWidgetSnapshot);
      }, SETTLE_MS);
    };
    const offWorkspace = useWorkspace.subscribe((s, prev) => {
      const cards = s.summary?.needs_you !== prev.summary?.needs_you;
      if (cards) cardsChanged = true;
      if (cards || s.agents !== prev.agents || s.conversations !== prev.conversations) settle();
    });
    const offPrefs = usePrefs.subscribe((s, prev) => {
      if (s.lang !== prev.lang) settle();
    });
    const offApp = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        if (timer) clearTimeout(timer);
        timer = null;
        void publishWidgetSnapshot();
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      offWorkspace();
      offPrefs();
      offApp.remove();
    };
  }, [loading, userId]);
}
