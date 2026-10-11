/**
 * Where the home route starts on a cold start (spec docs/specs/20261008-mobile-bots.md
 * §2.2 冷启动, D3; docs/specs/20261011-agent-first-class.md §3.1 — the main thread is
 * the default entry) — pure, so the root vitest pins every rule
 * (./initial-surface.test.ts). The home dispatcher (app/(drawer)/(main)/index.tsx)
 * asks once per process, the first time `/` mounts:
 *
 * - `wait`   — prefs are not read yet, or nothing is remembered and the main
 *   thread is not known yet (a first launch: the main thread is remembered
 *   from then on): hold the surface. The dispatcher gives up after 400 ms
 *   (`gaveUp`) and asks again — whatever is known by then decides.
 * - `thread` — reopen the Agent thread the member left the app in; with none
 *   remembered, the main thread (主线: the member's DM with their main Agent,
 *   the built-in Sprouty).
 * - `chat`   — leave the route alone: whatever it names (a chat, a thread, a deep
 *   link's params), or — naming nothing, and the wait gave up before the main
 *   thread was known — a new chat, as before the main thread existed.
 *
 * A route that already names a surface always wins over the restore, and so
 * does a deep link stacked over home (`covered`): `greenhouse://bots?c=…` or
 * `greenhouse://chat/<id>` mount their forwarder on top of a param-less home,
 * and a restore landing after the forwarder's `dismissTo` would overwrite it.
 * Same for a notification tap that launched the app (`launchedByPush`): its
 * route arrives only once auth is in (maybe after a station switch), later
 * than the restore would.
 * A remembered thread wins over the main thread, so the main thread waits for
 * the prefs too. Without Agents (off, refused, Android) there is nothing to
 * restore and no main thread — and no wait, so the home renders exactly as it
 * did before Agents.
 */

import type { LastThread } from '../last-surface';
import type { HomeParams } from '../nav';

export interface SurfaceInput {
  /** The home route's params, normalised (`homeParams`). */
  params: HomeParams;
  /** Persisted prefs have been read. */
  hydrated: boolean;
  /** The dispatcher's wait timed out: settle on what is known (prefs still unread = nothing remembered). */
  gaveUp: boolean;
  /** The remembered thread for this station + account (`lastThread()`), null when none. */
  last: LastThread | null;
  /**
   * The main thread — Sprouty's DM and its title: the Bots store's answer, else the one remembered
   * for this station + account (`mainThread()`, so usually known as soon as prefs are) — null until known.
   */
  main: LastThread | null;
  /** `botsEnabledNow()`. */
  botsEnabled: boolean;
  /** This process already decided (warm start, a second home mount): never restore twice. */
  restored: boolean;
  /** Another route is stacked over home (a cold-start deep link): it decides, not the restore. */
  covered?: boolean;
  /** A tap on a notification launched the app (src/push/handler.ts): the tap decides, not the restore. */
  launchedByPush?: boolean;
}

export type Surface = { kind: 'wait' } | { kind: 'thread'; c: string; title: string } | { kind: 'chat' };

const WAIT: Surface = { kind: 'wait' };
const CHAT: Surface = { kind: 'chat' };

export function initialSurface(i: SurfaceInput): Surface {
  if (i.restored || i.covered || i.launchedByPush || namesSurface(i.params) || !i.botsEnabled) return CHAT;
  if (!i.hydrated && !i.gaveUp) return WAIT;
  if (i.last?.c) return { kind: 'thread', c: i.last.c, title: i.last.title };
  if (i.main?.c) return { kind: 'thread', c: i.main.c, title: i.main.title };
  return i.gaveUp ? CHAT : WAIT;
}

/** The route already says where to go: any param the drawer, a sheet or a link sets. */
function namesSurface(p: HomeParams): boolean {
  return !!(p.id || p.c || p.compose || p.request || p.profile || p.title || p.ro === '1');
}
