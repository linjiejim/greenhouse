/**
 * Who may run a Bots conversation right now (spec §4.1, design review R5).
 *
 * Two questions every entry point (the chat route, idle delivery, the sweeper,
 * the run itself) must answer the same way:
 * - is the conversation's owner allowed to run Bots at all — active, internal
 *   (team / super) and with the `bots` feature? A suspended or mid-reset
 *   member's queued items stay in the inbox untouched until they are active
 *   again; nothing claims a slot for them;
 * - does this process own the conversation's run? The in-memory ChatRun
 *   registry serialises runs inside one process; a database advisory lock
 *   (`db.bots.tryLockConversationRun`) makes that exclusive across API
 *   processes, so an idle blue/green slot's sweeper can never open a second
 *   run on a conversation another slot is streaming.
 */

import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { BOTS_SESSION_CHANNEL } from '@greenhouse/types/session';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { userHasFeature } from '../../auth/features.js';
import { chatRunRegistry, type ChatRun } from '../../chat/runs.js';

/** The owner may run Bots: active, internal, `bots` feature on. */
export async function botsOwnerEligible(
  db: DatabaseProvider,
  user: Pick<UserRow, 'id' | 'role' | 'status'> | undefined | null,
): Promise<boolean> {
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) return false;
  return userHasFeature(user.id, user.role, 'bots', db);
}

/**
 * Claim a conversation's run slot in this process AND across processes.
 * Returns null when either is held (the caller queues instead). The returned
 * run must end through the chain's finish (or `releaseBotsRun`), which also
 * drops the cross-process lock.
 */
export async function claimBotsRun(db: DatabaseProvider, sessionId: string, userId: string): Promise<ChatRun | null> {
  const run = chatRunRegistry.claim(sessionId, userId);
  if (!run) return null;
  let locked = false;
  try {
    locked = await db.bots.tryLockConversationRun(sessionId);
  } catch (error) {
    logger.warn('[bots] run lock unavailable — not starting a run', { sessionId, error: toErrorMessage(error) });
  }
  if (!locked) {
    chatRunRegistry.release(run);
    return null;
  }
  return run;
}

/** Drop the cross-process lock of a run this process owned (idempotent, never throws). */
export async function unlockBotsRun(db: DatabaseProvider, sessionId: string): Promise<void> {
  await db.bots.unlockConversationRun(sessionId).catch((error: unknown) => {
    logger.warn('[bots] releasing the run lock failed', { sessionId, error: toErrorMessage(error) });
  });
}

/** Release a claimed run that never streamed (writes-only delivery, a failed start). */
export async function releaseBotsRun(db: DatabaseProvider, run: ChatRun): Promise<void> {
  if (run.sessionId) await unlockBotsRun(db, run.sessionId);
  chatRunRegistry.release(run);
}

/**
 * Stop this process's in-flight Bots runs of a member who just lost Bots
 * (an admin switched the `bots` feature off). A suspension stops every run of
 * the account already; this one leaves their ordinary chats alone. Runs do not
 * carry a channel, so each active run's session is checked. Queued items stay
 * in the inbox — no entry point claims a slot for an ineligible owner — and the
 * stopped turns persist their partials like any interruption. Never throws.
 */
export async function stopBotsRunsForUser(db: DatabaseProvider, userId: string): Promise<number> {
  let stopped = 0;
  for (const run of chatRunRegistry.listActiveForUser(userId)) {
    try {
      const session = run.sessionId ? await db.sessions.getById(run.sessionId) : undefined;
      if (session?.channel !== BOTS_SESSION_CHANNEL) continue;
      run.requestStop('account-security');
      stopped += 1;
    } catch (error) {
      logger.warn('[bots] could not stop a Bots run of a member losing access', {
        userId,
        sessionId: run.sessionId,
        error: toErrorMessage(error),
      });
    }
  }
  return stopped;
}
