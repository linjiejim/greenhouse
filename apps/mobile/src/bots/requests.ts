/**
 * "Needs you" cards: one view of each request's latest state, shared by the
 * thread engine (a conversation's cards) and the needs-you sheet (every
 * conversation's pending cards), and one reading of a refused decision.
 *
 * Both are mobile ports of web logic that is inlined in components there:
 * `mergeRequests` = the `requests` memo of use-bot-conversation.ts (:338-355),
 * `classifyDecision` = request-decision.ts `classifyDecisionError` (:43-49) —
 * the latter pinned by a text tripwire in vendor/vendor.parity.test.ts, so a
 * web change to it turns that test red here.
 */

import type { BotRequestErrorCode, BotRequestView } from '../shared/bots';

/**
 * Latest state of every card from three sources, applied in this order: the
 * REST copies (conversation detail `requests` / the pending list), the live
 * stream's `bot-request` events, then the decisions made on this device
 * (`useBots.requestOverrides`). A settled state never reverts to pending: the
 * stream's copy of a card is the one it was raised with and keeps saying
 * "pending" until the run ends, and a REST page fetched before a decision
 * landed says the same.
 */
export function mergeRequests(src: {
  rest: readonly BotRequestView[];
  live: readonly BotRequestView[];
  overrides: Record<string, BotRequestView>;
}): Map<string, BotRequestView> {
  const map = new Map<string, BotRequestView>();
  const put = (request: BotRequestView) => {
    const known = map.get(request.id);
    if (known && known.status !== 'pending' && request.status === 'pending') return;
    map.set(request.id, request);
  };
  src.rest.forEach(put);
  src.live.forEach(put);
  Object.values(src.overrides).forEach(put);
  return map;
}

/**
 * 409 codes that mean "someone already settled this" — or is settling it
 * right now, on another device (a code-less 409 is the older form of the same).
 */
const ALREADY_SETTLED: ReadonlySet<string> = new Set<BotRequestErrorCode>(['already_decided', 'deciding']);

/**
 * How a failed `POST /api/bots/requests/:id` reads: `stale` — already settled
 * elsewhere, re-read quietly; `refused` — the server could not carry it out
 * (or never heard it: status 0) and the card stays pending.
 */
export function classifyDecision(status: number, code: string | null): 'stale' | 'refused' {
  return status === 409 && (code === null || ALREADY_SETTLED.has(code)) ? 'stale' : 'refused';
}
