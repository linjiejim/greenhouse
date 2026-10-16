/**
 * An Agent's background runs as Live Activities on this phone (spec
 * docs/specs/20261010-mobile-live-activity.md §2.2, §3.3) — the side effects; what to start,
 * update and end is decided by `planActivities` (./model.ts).
 *
 * `reconcile()` lists the member's active runs started from a conversation
 * (`GET /api/runs?state=active&source=conversation`), reads each run the phone shows that is no
 * longer active (`GET /api/runs/:id`, for its final state), reads the activities on the phone,
 * plans and applies. It runs when the identity, the push registration or the switch changes,
 * when the app comes to the foreground, and on `run.updated` events. One at a time; calls made
 * meanwhile run it once more.
 *
 * What may start one (`canStart`): the switch (Settings → 通知, device-wide, default off —
 * D10), iOS allowing Live Activities for the app, and a push registration on this station —
 * only a push can end an activity while the app is in the background (D7). What ends them
 * all: the switch off, signing out, another station or account.
 *
 * The switch is also told to the station (`prefs.live_activity` of this phone's push
 * registration), whose "done" push then carries `content-available` — the native side
 * (modules/widget-bridge WidgetBridgeAppDelegate) ends the activity as it arrives.
 */

import { Platform } from 'react-native';
import { create } from 'zustand';
import {
  endTaskActivity,
  listTaskActivitiesJson,
  listWidgetArt,
  liveActivitiesState,
  startTaskActivity,
  updateTaskActivity,
} from '../../modules/widget-bridge';
import { getRun, listRuns } from '../api/runs';
import { loadPref, savePref } from '../api/token-storage';
import { parseMs } from '../data/time';
import { setPushPrefs, usePush } from '../push/register';
import type { RunView } from '../shared/contract';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useStations } from '../store/stations';
import { useWorkspace } from '../store/workspace';
import { renderWidgetArt } from '../widget/art-host';
import { activityArt, attributesFor, parseActivities, planActivities, pruneShown, type Action } from './model';

const IOS = Platform.OS === 'ios';
const SWITCH_PREF = 'live_activity';
const SHOWN_PREF = 'live_activity_shown';
/** How long a start waits for the Agent's faces to be drawn (then it starts with the fallback). */
const ART_WAIT_MS = 1200;

interface LiveActivityState {
  /** This binary and iOS can run them (iOS 17+, with the native part). */
  supported: boolean;
  /** The member allows Live Activities for the app (iOS settings, or the lock screen's first ask). */
  systemEnabled: boolean;
  /** The member's switch — device-wide, off until switched on (D10). */
  on: boolean;
  hydrated: boolean;
}

export const useLiveActivity = create<LiveActivityState>(() => ({
  supported: false,
  systemEnabled: false,
  on: false,
  hydrated: false,
}));

/** Read what iOS says now (it may change in Settings while the app is away). */
export function readLiveActivitySystem(): void {
  const state = liveActivitiesState();
  useLiveActivity.setState({ supported: IOS && state.supported, systemEnabled: state.enabled });
}

export async function hydrateLiveActivity(): Promise<void> {
  readLiveActivitySystem();
  const raw = await loadPref(SWITCH_PREF);
  useLiveActivity.setState({ on: raw === '1', hydrated: true });
}

/**
 * The phone's push registration on the active station says whether the switch is on, so the
 * station knows to wake the app when a run ends. False when it could not be told.
 */
export async function syncLiveActivityPref(): Promise<boolean> {
  const device = usePush.getState().device;
  const on = useLiveActivity.getState().on;
  if (!device || device.prefs.live_activity === on) return true;
  return setPushPrefs({ live_activity: on });
}

/** The switch (Settings → 通知). Returns false when the station could not be told. */
export async function setLiveActivityOn(on: boolean): Promise<boolean> {
  useLiveActivity.setState({ on });
  await savePref(SWITCH_PREF, on ? '1' : null);
  const told = await syncLiveActivityPref();
  void reconcile();
  return told;
}

// ─── Shown runs (never show a run twice) ─────────────────

async function loadShown(): Promise<Record<string, number>> {
  try {
    const raw = await loadPref(SHOWN_PREF);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return pruneShown(parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}, Date.now());
  } catch {
    return {};
  }
}

async function rememberShown(run: string): Promise<void> {
  const shown = await loadShown();
  shown[run] = Date.now();
  await savePref(SHOWN_PREF, JSON.stringify(shown));
}

// ─── Reconcile ───────────────────────────────────────────

let running: Promise<void> | null = null;
let again = false;

export function reconcile(): Promise<void> {
  if (!IOS) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await reconcileOnce();
      } while (again);
    } catch {
      // the lock screen just stays as it was; the next trigger tries again
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * The member's active runs from conversations, plus the latest state of the ones on the phone
 * that are no longer among them (to end with their final state). `complete`: every active one.
 */
async function listFollowed(onPhone: readonly string[]): Promise<{ runs: RunView[] | null; complete: boolean }> {
  const active = await listRuns({ state: 'active', source: 'conversation', limit: 50 });
  if (!active.ok) return { runs: null, complete: false };
  const runs = [...active.data.items];
  const listed = new Set(runs.map((run) => run.id));
  for (const id of new Set(onPhone)) {
    if (listed.has(id)) continue;
    const one = await getRun(id);
    if (one.ok) runs.push(one.data);
  }
  return { runs, complete: active.data.next_cursor === null };
}

async function reconcileOnce(): Promise<void> {
  const { supported, hydrated, on } = useLiveActivity.getState();
  if (!supported || !hydrated) return;
  readLiveActivitySystem();
  const { user, loading } = useAuth.getState();
  if (loading) return;
  const station = useStations.getState().activeId;
  const activities = parseActivities(listTaskActivitiesJson());
  const push = usePush.getState();
  const pushReady = push.support === 'enabled' && push.permission === 'granted' && !push.off && push.device !== null;
  const signedIn = !!user && !!station;
  const canStart = on && pushReady && useLiveActivity.getState().systemEnabled;

  let listed: { runs: RunView[] | null; complete: boolean } = { runs: null, complete: false };
  if (signedIn && on && (canStart || activities.length > 0)) {
    listed = await listFollowed(activities.filter((activity) => !activity.ended).map((activity) => activity.run));
  }
  // the station or account may have changed while the list was on its way
  if (useStations.getState().activeId !== station || useAuth.getState().user?.id !== user?.id) {
    again = true;
    return;
  }
  const shown = await loadShown();
  const actions = planActivities({
    runs: listed.runs,
    activities,
    ctx: {
      now: Date.now(),
      station: signedIn ? station : null,
      user: signedIn ? user.id : null,
      switchOn: on,
      canStart,
      complete: listed.complete,
      shown: new Set(Object.keys(shown)),
    },
    parseMs,
  });
  for (const action of actions) await apply(action, { station: station ?? '', user: user?.id ?? '' });
}

async function apply(action: Action, who: { station: string; user: string }): Promise<void> {
  if (action.kind === 'update') {
    await updateTaskActivity(action.id, JSON.stringify({ state: action.state, staleAt: action.staleAt }));
    return;
  }
  if (action.kind === 'end') {
    await endTaskActivity(action.id, action.state ? JSON.stringify({ state: action.state }) : null, action.dismissAt);
    return;
  }
  const agent = useWorkspace.getState().agents?.find((item) => item.id === action.run.agent_id) ?? null;
  const { art, jobs } = activityArt(agent);
  const have = new Set(listWidgetArt());
  const missing = jobs.filter((job) => !have.has(job.key));
  if (missing.length > 0) {
    await Promise.race([renderWidgetArt(missing), new Promise((resolve) => setTimeout(resolve, ART_WAIT_MS))]);
  }
  const attributes = attributesFor({
    run: action.run,
    station: who.station,
    user: who.user,
    agent: agent ? { name: agent.name, main: agent.is_main } : null,
    art,
    lang: usePrefs.getState().lang,
    preview: usePush.getState().device?.prefs.preview ?? false,
  });
  const id = startTaskActivity(
    JSON.stringify({ attributes, state: action.state, staleAt: action.staleAt, relevance: action.relevance }),
  );
  if (id) await rememberShown(action.run.id);
}
