/**
 * The new-chat hero's bridge row (spec §2.5.2): one tappable line that points
 * from a fresh chat back into the member's Bots — pure, so the root vitest pins
 * the priority (./bridge-item.test.ts):
 *
 *  1. another conversation is waiting for the member (pending cards — the
 *     capsule's pick, soonest expiry first, else the rows' counts while the
 *     pending list has not been read);
 *  2. a background task reported back somewhere (the newest arrival);
 *  3. a conversation has something unread (server order: newest activity first);
 *  4. otherwise: carry on with Sprouty (its DM may not exist yet — null, the tap
 *     bootstraps it).
 *
 * null until the Bot list is in (there is no Sprouty name to say yet). The new
 * chat has no conversation of its own, so nothing is excluded.
 */

import type { BotConversationSummary, BotView } from '../../shared/bots';
import { capsuleItem, sproutyBot, sproutyDm, type Arrival, type BotsData } from '../store-core';

export type BridgeItem =
  | {
      kind: 'needs_you';
      /** The conversation to open when exactly one card waits. */
      sessionId: string;
      /** The Bot asking (null: a card without one, or only the row count is known). */
      botId: string | null;
      /** The card to scroll to (null: only the row count is known). */
      requestId: string | null;
      /** Cards waiting across every conversation (> 1 → the needs-you sheet). */
      count: number;
    }
  | { kind: 'report'; sessionId: string; arrival: Arrival }
  | { kind: 'unread'; row: BotConversationSummary }
  | { kind: 'sprouty'; bot: BotView; sessionId: string | null };

export function bridgeItem(
  s: Pick<BotsData, 'bots' | 'botsLoaded' | 'conversations' | 'pendingRequests' | 'requestOverrides' | 'arrivals'>,
  now: number,
): BridgeItem | null {
  if (!s.botsLoaded) return null;
  const capsule = capsuleItem(s, null, now);
  if (capsule?.kind === 'needs_you') {
    const { request, count } = capsule;
    return { kind: 'needs_you', sessionId: request.session_id, botId: request.bot_id, requestId: request.id, count };
  }
  // The pending list has not been read (or lags the list): the rows still say who is waiting.
  if (s.pendingRequests.length === 0) {
    const waiting = s.conversations.filter((row) => row.pending_requests > 0);
    if (waiting.length > 0) {
      const first = waiting[0]!;
      return {
        kind: 'needs_you',
        sessionId: first.session_id,
        botId: first.kind === 'direct' ? first.owner_bot_id : null,
        requestId: null,
        count: waiting.reduce((sum, row) => sum + row.pending_requests, 0),
      };
    }
  }
  if (capsule?.kind === 'arrival') return { kind: 'report', sessionId: capsule.sessionId, arrival: capsule.arrival };
  const unread = s.conversations.find((row) => row.attention === 'unread');
  if (unread) return { kind: 'unread', row: unread };
  const bot = sproutyBot(s);
  return bot ? { kind: 'sprouty', bot, sessionId: sproutyDm(s) } : null;
}
