/**
 * The computer page's pure rules (tested in ./model.test.ts): how paths read,
 * how long the member has held the computer, and which "needs you" card the
 * page answers. Which computer (one per Agent) is ./target.ts.
 */

import type { BotRequestView } from '../../shared/bots';
import type { TranslationKey } from '../../lib/i18n';
import { humanCheckTakeover, implicitTakeover } from '../vendor/web-helpers';

const HOME = '/home/agent';

/** `/home/agent/work/a` → `~/work/a`. */
export function homePath(path: string): string {
  return path === HOME ? '~' : path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}

/** The folder above, or null at ~ (the member's view ends at the home folder). */
export function parentPath(path: string): string | null {
  if (path === HOME || !path.startsWith(`${HOME}/`)) return null;
  return path.slice(0, path.lastIndexOf('/')) || HOME;
}

/** `mm:ss` (or `h:mm:ss`) since an ISO time; 00:00 without one. */
export function heldFor(since: string | null, now: number): string {
  const start = since ? Date.parse(since) : NaN;
  const s = Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** Cards a member answers at the computer: a take-over (asked for or raised by the computer) or a sign-in. */
export function isComputerCard(r: Pick<BotRequestView, 'kind'>): boolean {
  return r.kind === 'takeover' || r.kind === 'login';
}

/**
 * The card the page answers: the one it was opened for (`?request=`) while it
 * is pending, else the oldest pending computer card of the conversation it was
 * opened from (`?c=`) — never one from another conversation, and (one computer
 * per Agent) never one about another computer: `onComputer` says whether a
 * card's Agent works on the computer the page shows (a guest Agent in the
 * conversation has its own).
 */
export function cardToAnswer(
  pending: readonly BotRequestView[],
  opts: { requestId?: string; sessionId?: string; onComputer?: (r: BotRequestView) => boolean },
): BotRequestView | null {
  if (opts.requestId) {
    const asked = pending.find((r) => r.id === opts.requestId);
    if (asked) return asked.status === 'pending' ? asked : null;
  }
  if (!opts.sessionId) return null;
  const here = pending.filter(
    (r) =>
      r.status === 'pending' &&
      r.session_id === opts.sessionId &&
      isComputerCard(r) &&
      (opts.onComputer ? opts.onComputer(r) : true),
  );
  return here.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] ?? null;
}

/** The banner line for that card. */
export function needsKey(r: Pick<BotRequestView, 'kind' | 'payload'>): TranslationKey {
  if (r.kind === 'login') return 'bots.computer.needsLogin';
  if (r.kind === 'takeover' && !implicitTakeover(r.payload) && humanCheckTakeover(r.payload)) return 'bots.computer.needsCaptcha';
  return 'bots.computer.needsTakeover';
}
