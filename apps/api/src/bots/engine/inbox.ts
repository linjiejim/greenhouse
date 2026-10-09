/**
 * Single-writer delivery into a Bots conversation (spec §4.1, design review R5).
 *
 * Producers outside a running chain — a hand-back, a decided card, a finished
 * background task, a member message sent while the conversation was busy —
 * never append to the transcript themselves (a row landing mid-turn would make
 * that turn's save fail). They call `deliverToConversation`, which:
 * 1. persists the item in `bot_inbox` first (durable across restarts);
 * 2. tries to claim the conversation's run (in this process and, through a
 *    database advisory lock, across API processes — run-slot.ts) —
 *    - held anywhere: done; the running chain drains the inbox between turns;
 *    - free and only writes queued (events, reports): applies them and
 *      releases the slot silently;
 *    - free and a Bot must speak (`continue`, member message): starts a
 *      server-initiated chain in that slot; web clients attach through the
 *      `chat:run` push exactly as for their own messages.
 * Items are consumed only after they were applied (claim-then-apply, see
 * chain.ts). A conversation whose owner may not run Bots (suspended, mid-reset,
 * demoted, `bots` off) is never claimed: its items wait, untouched, until the
 * owner is active again. A retired group chat (read-only history) never starts
 * a chain: everything queued for it — a task report, an event, a wake-up's
 * line — is written as a record and nobody is woken.
 *
 * A 5-second sweeper retries conversations whose inbox still holds items (a
 * release-then-check race, a restart, a lock released by another slot),
 * oldest pending work first. A conversation whose server-initiated run could
 * not even load backs off (5 s doubling to 10 min) so it cannot hog the sweep.
 */

import { getDb, type DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ToolRegistry } from '../../agent.js';
import { chatRunRegistry, type ChatRun } from '../../chat/runs.js';
import { connectionManager } from '../../ws/connection-manager.js';
import { applyInboxRow, parseInboxRow, runBotsRun, type BotsRunOutcome } from './chain.js';
import type { InboxItem } from './inbox-types.js';
import { botsOwnerEligible, claimBotsRun, releaseBotsRun } from './run-slot.js';
import { TranscriptWriter } from './writer.js';

const SWEEP_INTERVAL_MS = 5_000;
const SWEEP_BATCH = 50;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;

let toolRegistry: ToolRegistry | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
/** Conversations whose server-initiated run failed to load, and when to try again. */
const backoff = new Map<string, { failures: number; retryAt: number }>();

/** Boot wiring: the static tool registry server-initiated chains need. */
export function setInboxToolRegistry(registry: ToolRegistry | null): void {
  toolRegistry = registry;
}

function noteRunOutcome(sessionId: string, outcome: BotsRunOutcome): void {
  if (outcome.status === 'error' && !outcome.loaded) {
    const failures = (backoff.get(sessionId)?.failures ?? 0) + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    backoff.set(sessionId, { failures, retryAt: Date.now() + delay });
    logger.warn('[bots] server-initiated run could not start — backing off', { sessionId, failures, delayMs: delay });
  } else backoff.delete(sessionId);
}

/** Start a server-initiated run in a slot this call claimed; the chain drains every item itself, in order. */
function startServerRun(run: ChatRun, userId: string, sessionId: string, inboxId: number, db: DatabaseProvider) {
  void runBotsRun({
    run,
    userId,
    sessionId,
    toolRegistry: toolRegistry!,
    trigger: { kind: 'continue', items: [] },
    triggerKey: `inbox-${inboxId}`,
    db,
  })
    .then((outcome) => noteRunOutcome(sessionId, outcome))
    .catch((error) => logger.error('[bots] server-initiated run crashed', { sessionId, error: toErrorMessage(error) }));
}

/**
 * Try to process a conversation's inbox now. Returns true when this call took
 * the slot (wrote items or started a chain).
 */
export async function drainIdleConversation(sessionId: string, db: DatabaseProvider = getDb()): Promise<boolean> {
  if (chatRunRegistry.getActive(sessionId)) return false; // the running chain drains it
  const session = await db.sessions.getById(sessionId);
  if (!session || session.channel !== 'bots' || !session.user_id) return false;
  const userId = session.user_id;
  // An owner who may not run Bots right now: leave the items queued, claim nothing.
  if (!(await botsOwnerEligible(db, await db.users.getById(userId)))) return false;
  const run = await claimBotsRun(db, sessionId, userId);
  if (!run) return false;

  let handedOff = false;
  try {
    // A retired group chat: record what is queued, never start a turn there.
    const closed = (await db.bots.getConversation(userId, sessionId))?.kind === 'group';
    const isTurn = (row: { kind: string }) => !closed && (row.kind === 'user_message' || row.kind === 'continue');
    const rows = await db.bots.listPendingInbox(sessionId);
    const firstTrigger = rows.find(isTurn);
    if (firstTrigger && toolRegistry) {
      handedOff = true;
      startServerRun(run, userId, sessionId, firstTrigger.id, db);
      return true;
    }
    if (rows.length === 0) return false;
    const latest = await db.sessions.getLatestMessage(sessionId);
    const writer = new TranscriptWriter(db, sessionId, latest ?? null);
    let wrote = false;
    for (const row of rows) {
      // Without a registry (tests, early boot) Bot turns wait for the next sweep.
      if (isTurn(row)) break;
      const item = parseInboxRow(row);
      if (!item) {
        await db.bots.quarantineInbox(row.id);
        logger.error('[bots] quarantined a malformed inbox item', { sessionId, inboxId: row.id, kind: row.kind });
        continue;
      }
      const outcome = await applyInboxRow(db, writer, row, item);
      if (outcome === 'failed') break; // order is preserved; the next sweep retries it
      if (outcome === 'applied') wrote = true;
    }
    if (wrote) {
      await db.bots.touchActivity(sessionId);
      connectionManager.sendToUser(userId, { type: 'bots:conversation', sessionId });
    }
    // A member message may have been queued while this slot was held for the
    // writes above (their POST got 202): answer it now rather than next sweep.
    if (toolRegistry) {
      const remaining = await db.bots.listPendingInbox(sessionId);
      const trigger = remaining.find(isTurn);
      if (trigger) {
        handedOff = true;
        startServerRun(run, userId, sessionId, trigger.id, db);
        return true;
      }
    }
    return wrote;
  } catch (error) {
    logger.warn('[bots] inbox delivery failed', { sessionId, error: toErrorMessage(error) });
    return false;
  } finally {
    // Writes-only path: no stream ever existed, so release silently.
    if (!handedOff) await releaseBotsRun(db, run);
  }
}

/** Single-writer delivery (see the module comment). Durable before it returns. */
export async function deliverToConversation(sessionId: string, item: InboxItem): Promise<void> {
  const db = getDb();
  await db.bots.enqueueInbox(sessionId, item.kind, item as unknown as Record<string, unknown>);
  await drainIdleConversation(sessionId, db);
}

/** One sweep over conversations with queued items (exported for tests). */
export async function sweepInboxes(db: DatabaseProvider = getDb()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    // Fetch a little more than a batch so sessions in backoff don't shrink it.
    const sessions = await db.bots.listSessionsWithPendingInbox(SWEEP_BATCH + Math.min(backoff.size, SWEEP_BATCH));
    const now = Date.now();
    let attempted = 0;
    for (const sessionId of sessions) {
      if ((backoff.get(sessionId)?.retryAt ?? 0) > now) continue;
      if (attempted++ >= SWEEP_BATCH) break;
      await drainIdleConversation(sessionId, db);
    }
  } catch (error) {
    logger.warn('[bots] inbox sweep failed', { error: toErrorMessage(error) });
  } finally {
    sweeping = false;
  }
}

export function startInboxSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweepInboxes(), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopInboxSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Tests only. */
export function _resetInboxStateForTest(): void {
  backoff.clear();
  sweeping = false;
}
