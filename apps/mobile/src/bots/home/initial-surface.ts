/**
 * Where the home route starts on a cold start (spec docs/specs/20261008-mobile-bots.md
 * §2.2 冷启动, D3) — pure, so the root vitest pins every rule
 * (./initial-surface.test.ts). The home dispatcher (app/(drawer)/(main)/index.tsx)
 * asks once per process, the first time `/` mounts:
 *
 * - `wait`   — prefs are not read yet: hold the surface. The dispatcher gives up
 *   after 400 ms and asks again as if hydrated with nothing remembered.
 * - `thread` — reopen the Bots thread the member left the app in.
 * - `chat`   — leave the route alone: whatever it names (a chat, a thread, a deep
 *   link's params), or — naming nothing — today's new chat.
 *
 * A route that already names a surface always wins over the restore, and so
 * does a deep link stacked over home (`covered`): `greenhouse://bots?c=…` or
 * `greenhouse://chat/<id>` mount their forwarder on top of a param-less home,
 * and a restore landing after the forwarder's `dismissTo` would overwrite it.
 * Without Bots (off, refused, Android) there is nothing to restore — and no
 * wait, so the home renders exactly as it did before Bots.
 */

import type { LastThread } from '../last-surface';
import type { HomeParams } from '../nav';

export interface SurfaceInput {
  /** The home route's params, normalised (`homeParams`). */
  params: HomeParams;
  /** Persisted prefs have been read (the dispatcher passes true once its wait timed out). */
  hydrated: boolean;
  /** The remembered thread for this station + account (`lastThread()`), null when none. */
  last: LastThread | null;
  /** `botsEnabledNow()`. */
  botsEnabled: boolean;
  /** This process already decided (warm start, a second home mount): never restore twice. */
  restored: boolean;
  /** Another route is stacked over home (a cold-start deep link): it decides, not the restore. */
  covered?: boolean;
}

export type Surface = { kind: 'wait' } | { kind: 'thread'; c: string; title: string } | { kind: 'chat' };

const WAIT: Surface = { kind: 'wait' };
const CHAT: Surface = { kind: 'chat' };

export function initialSurface(i: SurfaceInput): Surface {
  if (i.restored || i.covered || namesSurface(i.params) || !i.botsEnabled) return CHAT;
  if (!i.hydrated) return WAIT;
  return i.last?.c ? { kind: 'thread', c: i.last.c, title: i.last.title } : CHAT;
}

/** The route already says where to go: any param the drawer, a sheet or a link sets. */
function namesSurface(p: HomeParams): boolean {
  return !!(p.id || p.c || p.compose || p.request || p.profile || p.title || p.ro === '1');
}
