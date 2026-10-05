/**
 * Bots transcripts leave with their member.
 *
 * Sessions normally outlive their user (history stays readable for audit), but a
 * Bots conversation carries the member's private context: page text from their
 * signed-in browser, shell output, Bot-private reasoning. Once the member is
 * deleted nobody can continue or delete it (`canWriteSession` is owner-only for
 * `channel='bots'`), so deleting a member takes their Bots conversations and the
 * `bottask-` background-task children along. The `bot_*` rows follow through the
 * `bot_conversations.session_id` cascade.
 *
 * A session whose runtime run is still settling (a background task asked to
 * cancel but not yet terminal) cannot be deleted yet; the hourly sweep retries
 * every Bots session whose owner no longer exists.
 */

import { getDb, SessionActiveRuntimeError } from '@greenhouse/db';
import { BOTS_SESSION_CHANNEL, HIDDEN_SESSION_ID_PREFIXES } from '@greenhouse/types/session';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { chatRunRegistry } from '../chat/runs.js';
import { deleteObjectAtKey } from '../storage/uploads.js';

const SWEEP_INTERVAL_MS = 60 * 60_000;

export interface BotsPurgeResult {
  deleted: number;
  /** Sessions skipped because a chat turn or runtime run is still active; the sweep retries them. */
  deferred: number;
}

/**
 * Delete a member's Bots conversations (or, with `null`, those of members that
 * no longer exist) together with their attachment blobs. Never throws: a member
 * deletion must not fail on transcript cleanup.
 */
export async function purgeBotsConversations(userId: string | null): Promise<BotsPurgeResult> {
  const result: BotsPurgeResult = { deleted: 0, deferred: 0 };
  const db = getDb();
  let ids: string[];
  try {
    ids = await db.sessions.listIdsLeavingWithOwner(userId, {
      channels: [BOTS_SESSION_CHANNEL],
      idPrefixes: HIDDEN_SESSION_ID_PREFIXES,
    });
  } catch (error) {
    logger.warn(`[Bots] listing conversations to purge failed: ${toErrorMessage(error)}`);
    return result;
  }
  for (const id of ids) {
    if (chatRunRegistry.getActive(id)) {
      result.deferred += 1;
      continue;
    }
    try {
      const files = await db.chatFiles.listBySession(id);
      await db.sessions.delete(id);
      result.deleted += 1;
      await Promise.all(
        files.map((file) =>
          deleteObjectAtKey(file.storage_key).catch((error) => {
            logger.warn(`[Bots] attachment cleanup failed for ${file.storage_key}: ${toErrorMessage(error)}`);
          }),
        ),
      );
    } catch (error) {
      if (error instanceof SessionActiveRuntimeError) {
        result.deferred += 1;
        continue;
      }
      logger.warn(`[Bots] purging conversation ${id} failed: ${toErrorMessage(error)}`);
      result.deferred += 1;
    }
  }
  if (result.deleted || result.deferred) {
    logger.info(
      `[Bots] purged ${result.deleted} conversation(s)${userId ? ` of user ${userId}` : ' of deleted members'}` +
        (result.deferred ? `, ${result.deferred} deferred to the sweep` : ''),
    );
  }
  return result;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the orphan sweep (once at boot, then hourly). Idempotent. */
export function startBotsOrphanSweep(): void {
  if (sweepTimer) return;
  void purgeBotsConversations(null);
  sweepTimer = setInterval(() => void purgeBotsConversations(null), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopBotsOrphanSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
