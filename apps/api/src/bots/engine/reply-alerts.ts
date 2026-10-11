/**
 * "A Bot replied after you left" (docs/specs/20261010-mobile-push.md §2.1, §3.4 ②).
 *
 * Runs on the 30 s card-expiry sweep (approvals.ts). A direct conversation whose
 * last row is a finished Bot reply, written between 60 s and 30 min ago, that no
 * client has marked read and that has no pending card (the card already called
 * the member — one signal per conversation, as in the drawer) gets one
 * `bots_reply` fact (`bots-reply:<session>:<message>`) — which reaches the
 * member's phones through `publishNotification`.
 *
 * Why "unread after a minute" works as "the member left": the web (while
 * visible) and the phone (while the thread is on screen) mark a conversation read
 * only when someone really looks, so any client watching keeps it quiet. The
 * 30-minute bound keeps a deploy from back-filling old conversations. Only missed
 * replies reach the inbox, so the web inbox is not flooded; opening the
 * conversation (`POST /conversations/:id/read`) marks its alerts read.
 */

import { botsReplyDedupeKey, getDb, type DatabaseProvider } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

import { publishNotification } from '../../notifications/publish.js';
import { botsLocale, copy } from './copy.js';
import { TASK_REPORT_MESSAGE_PREFIX } from './inbox-types.js';

/** A reply nobody saw for this long counts as missed. */
export const REPLY_QUIET_MS = 60_000;
/** Replies older than this are never alerted (no back-fill after a deploy). */
export const REPLY_WINDOW_MS = 30 * 60_000;
const SWEEP_LIMIT = 100;

/** One pass; returns how many alerts it wrote. Never throws for one bad row. */
export async function sweepReplyAlerts(db: DatabaseProvider = getDb(), now: number = Date.now()): Promise<number> {
  const missed = await db.bots.listMissedReplies({
    quietMs: REPLY_QUIET_MS,
    windowMs: REPLY_WINDOW_MS,
    skipMessageIdPrefix: TASK_REPORT_MESSAGE_PREFIX,
    limit: SWEEP_LIMIT,
    now,
  });
  let written = 0;
  for (const row of missed) {
    try {
      const [owner, bot] = await Promise.all([
        db.users.getById(row.user_id),
        row.bot_id ? db.bots.getBot(row.user_id, row.bot_id) : Promise.resolve(undefined),
      ]);
      const locale = botsLocale(owner?.locale);
      const result = await publishNotification(db, {
        user_id: row.user_id,
        kind: 'bots_reply',
        title: copy.replyAlertTitle(locale, bot?.name ?? 'Bot'),
        body: copy.replyAlertBody(locale),
        payload: {
          bots_session_id: row.session_id,
          bot_id: row.bot_id,
          message_id: row.message_id,
          href: `#/bots?c=${encodeURIComponent(row.session_id)}`,
        },
        dedupe_key: botsReplyDedupeKey(row.session_id, row.message_id),
        push: { k: 'replies', sid: row.session_id, open: 'bots', bot_id: row.bot_id, message_id: row.message_id },
      });
      if (result.created) written += 1;
    } catch (error) {
      logger.warn('[bots] could not write a reply alert', {
        sessionId: row.session_id,
        error: toErrorMessage(error),
      });
    }
  }
  return written;
}
