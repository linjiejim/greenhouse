/**
 * The computer page's pure rules (./model.test.ts): how long the member has held the computer,
 * and which 「需要你」 card the page answers when it is handed back.
 */

import type { NeedsYou } from '../shared/contract';
import { parseMs } from '../data/time';

/** `mm:ss` (or `h:mm:ss`) since a moment in ms; 00:00 without one. */
export function heldFor(since: number | null, now: number): string {
  const s = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** Cards a member answers at the computer: a take-over or a sign-in. */
export const isComputerCard = (request: Pick<NeedsYou, 'kind'>) =>
  request.kind === 'takeover' || request.kind === 'login';

/**
 * The card handing the computer back settles: the one the page was opened for (`?request=`)
 * while it is pending, else the oldest pending computer card of this Agent — never one of
 * another Agent (each has its own computer).
 */
export function cardToAnswer(
  pending: readonly NeedsYou[],
  opts: { requestId?: string; agentId: string },
): NeedsYou | null {
  if (opts.requestId) {
    const asked = pending.find((request) => request.id === opts.requestId);
    if (asked)
      return asked.status === 'pending' && isComputerCard(asked) && asked.agent_id === opts.agentId ? asked : null;
  }
  return (
    pending
      .filter((request) => request.status === 'pending' && isComputerCard(request) && request.agent_id === opts.agentId)
      .sort((a, b) => (parseMs(a.created_at) || 0) - (parseMs(b.created_at) || 0))[0] ?? null
  );
}
