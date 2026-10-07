/**
 * Bots runs and chains — the floor controller driving one ChatRun
 * (spec §4.1–§4.2, design review R4/R5/R13).
 *
 * A run holds the conversation's single ChatRun slot (claimed by the chat
 * route for a member message, or by deliverToConversation for server-initiated
 * work — in this process and, through a database advisory lock, across API
 * processes; see run-slot.ts). Inside it:
 * - a chain = the Bot turns that answer one trigger (a member message, or a
 *   `continue` after a hand-back / approval / new Bot joining). Turns are
 *   ordered by the FloorController (depth-first hand-offs, the owner's single
 *   follow-up) and bounded by the chain budgets (8 turns, 4 asks, depth 3,
 *   600k weighted input / 30k output tokens, 60 steps, 20 minutes);
 * - before every chain and before every turn the roster is re-read (members,
 *   Bots, lead, group rules, the Bot-chat switch): a Bot invited or created
 *   mid-run can be addressed at once, one removed or archived stops speaking;
 * - between turns and before finishing, the durable inbox is drained in id
 *   order, claim-then-apply: an item is consumed only after it was applied,
 *   and every apply is idempotent (stable message ids), so a failure leaves it
 *   queued — retried, and quarantined after repeated failures — instead of
 *   lost or failing the run. Events and task reports are written, `continue`s
 *   join the queue, and a queued member message ends the current chain and
 *   starts a new one in the same run (≤16 turns per run): the interrupted
 *   chain's planned turns are dropped, but server-initiated `continue`s that
 *   had not run yet are carried into the new chain and run after its
 *   addressees;
 * - a member Stop ends the run: queued wake-ups are written but not run (the
 *   Bot stays quiet until the member asks), queued member messages stay and
 *   are answered right after;
 * - a soft stop (`ChatRun.requestInterrupt`: "handle my queued message now",
 *   or the first press of Stop) lets the speaking Bot finish its step (turn.ts),
 *   then drops the chain's planned turns: a queued member message starts the
 *   next chain at once (as an interjection would), otherwise the run ends the
 *   way a Stop ends it — but nothing in flight was thrown away. A chain that
 *   starts for a member message has taken the interrupt: it answers it;
 * - exactly ONE wire `finish` ends the run, then the run lock and the slot are
 *   released, `chat:run` is pushed, and the digest check is scheduled.
 */

import { getDb, INBOX_MAX_ATTEMPTS, type BotInboxRow, type DatabaseProvider } from '@greenhouse/db';
import type { BotEvent } from '@greenhouse/types/bots';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { ToolRegistry } from '../../agent.js';
import { resolveEffectiveTools } from '../../agent-runtime/tool-resolution.js';
import { chatRunRegistry, type ChatRun } from '../../chat/runs.js';
import { connectionManager } from '../../ws/connection-manager.js';
import type { InboxItem } from './inbox-types.js';
import { botsLocale, copy } from './copy.js';
import { botsEngineDeps } from './deps.js';
import { digestView, effectiveDigestUpto, scheduleDigestCheck } from './digest.js';
import { CHAIN_LIMITS, FloorController, type FloorItem } from './floor.js';
import { botsOwnerEligible, unlockBotsRun } from './run-slot.js';
import { memberMessageQueued, runBotTurn, type ChainState, type LimitReason, type RunContext } from './turn.js';
import { TranscriptChangedError, TranscriptWriter } from './writer.js';

type WakeUp = { botId: string; note: string };

/** What starts a chain. A member message is already persisted (it is the writer's tail). */
export type ChainTrigger =
  | {
      kind: 'message';
      reason: 'user' | 'interjection';
      mentions: readonly string[];
      /** Wake-ups the interrupted chain had not run yet: they run after this message's addressees. */
      carry?: readonly WakeUp[];
    }
  | { kind: 'continue'; items: readonly WakeUp[] };

export interface BotsRunArgs {
  run: ChatRun;
  userId: string;
  sessionId: string;
  toolRegistry: ToolRegistry;
  trigger: ChainTrigger;
  /** Correlates the run's Runtime traces (`bots:<key>:<turn>`): the member message id, or the inbox item. */
  triggerKey: string;
  db?: DatabaseProvider;
}

export interface BotsRunOutcome {
  status: 'completed' | 'error';
  /** False when the run could not even load (owner no longer eligible, conversation gone). */
  loaded: boolean;
}

class RunAbortError extends Error {}
/** The conversation was deleted while the run was going: end quietly. */
class ConversationGoneError extends Error {}
/** A soft stop with no member message waiting: the run ends (completed), nothing more runs. */
class RunInterruptedError extends Error {}

/** Parse a persisted inbox row back into its item (malformed rows are quarantined by the caller). */
export function parseInboxRow(row: { kind: string; payload: string }): InboxItem | null {
  const payload = safeJsonParse(row.payload, null) as (InboxItem & Record<string, unknown>) | null;
  if (!payload || typeof payload !== 'object' || payload.kind !== row.kind) return null;
  return payload;
}

/** The stable transcript id of the row an inbox item writes: re-applying the item is a no-op. */
export function inboxMessageId(inboxId: number, suffix = ''): string {
  return `bot-inbox:${inboxId}${suffix}`;
}

function isTrigger(row: Pick<BotInboxRow, 'kind'>): boolean {
  return row.kind === 'user_message' || row.kind === 'continue';
}

/**
 * Write one non-chain inbox item on the writer (shared by the chain drain and
 * idle delivery). Idempotent: with the inbox row id every write carries a
 * stable message id, and a task report is written at most once per task —
 * the first outcome wins, a later one (the reaper and the worker both
 * reporting) is dropped whatever its content.
 */
export async function writeInboxItem(
  db: DatabaseProvider,
  writer: TranscriptWriter,
  item: InboxItem,
  inboxId?: number,
): Promise<void> {
  const messageId = inboxId !== undefined ? inboxMessageId(inboxId) : undefined;
  if (item.kind === 'event') {
    await writer.appendEvent({
      text: item.text,
      event: item.event,
      botId: item.botId ?? null,
      ...(messageId ? { messageId } : {}),
    });
  } else if (item.kind === 'task_report') {
    const reportId = `bot-task-report:${item.runId}`;
    if (await db.sessions.getMessageById(reportId)) return;
    const event: BotEvent = {
      kind: 'task_report',
      run_id: item.runId,
      bot_id: item.botId,
      title: item.title,
      status: item.status,
    };
    await writer.appendBotRow({ botId: item.botId, content: item.report, event, messageId: reportId });
  } else if (item.kind === 'continue' && item.eventText && item.event) {
    await writer.appendEvent({
      text: item.eventText,
      event: item.event,
      botId: item.botId,
      ...(messageId ? { messageId } : {}),
    });
  } else if (item.kind === 'user_message') {
    await writer.appendUser({
      content: item.content,
      ...(item.images ? { images: item.images } : {}),
      ...(messageId ? { messageId } : {}),
    });
  }
}

/** A row that can never be applied: take it out of the queue and say so in the log. */
async function quarantineMalformed(db: DatabaseProvider, sessionId: string, row: BotInboxRow): Promise<void> {
  await db.bots.quarantineInbox(row.id);
  logger.error('[bots] quarantined a malformed inbox item', { sessionId, inboxId: row.id, kind: row.kind });
}

/**
 * Apply one pending inbox row, then consume it (claim-then-apply). Returns
 * `applied`, `taken` (another drainer consumed it first — its write was the
 * same idempotent row), `failed` (the row stays queued for the next drain,
 * its failure counted; the caller stops so order is kept) or `quarantined`
 * (it failed INBOX_MAX_ATTEMPTS times and is out of the queue; the caller
 * moves on). A foreign write (TranscriptChangedError) propagates.
 */
export async function applyInboxRow(
  db: DatabaseProvider,
  writer: TranscriptWriter,
  row: BotInboxRow,
  item: InboxItem,
): Promise<'applied' | 'taken' | 'failed' | 'quarantined'> {
  try {
    await writeInboxItem(db, writer, item, row.id);
  } catch (error) {
    if (error instanceof TranscriptChangedError) throw error;
    const reason = toErrorMessage(error);
    const attempts = await db.bots.recordInboxFailure(row.id, reason).catch(() => 0);
    if (attempts >= INBOX_MAX_ATTEMPTS) {
      await db.bots.quarantineInbox(row.id).catch(() => false);
      logger.error('[bots] quarantined an inbox item after repeated failures', {
        sessionId: writer.sessionId,
        inboxId: row.id,
        kind: row.kind,
        attempts,
        error: reason,
      });
      return 'quarantined';
    } else {
      logger.warn('[bots] applying an inbox item failed — it stays queued', {
        sessionId: writer.sessionId,
        inboxId: row.id,
        attempts,
        error: reason,
      });
    }
    return 'failed';
  }
  return (await db.bots.consumeInbox(row.id)) ? 'applied' : 'taken';
}

const ROSTER_EVENTS: ReadonlySet<BotEvent['kind']> = new Set(['joined', 'left', 'created']);

function changesRoster(item: InboxItem): boolean {
  if (item.kind === 'event') return ROSTER_EVENTS.has(item.event.kind);
  return item.kind === 'continue' && item.event !== undefined && ROSTER_EVENTS.has(item.event.kind);
}

/**
 * Re-read who is in the conversation and how it is set up. `members` and
 * `bots` are updated IN PLACE: every chain's FloorController holds the same
 * Set, so it sees the change without being rebuilt.
 */
async function refreshRoster(rc: RunContext): Promise<void> {
  const [conversation, allBots] = await Promise.all([
    rc.db.bots.getConversation(rc.user.id, rc.sessionId),
    rc.db.bots.listBots(rc.user.id, { includeArchived: true }),
  ]);
  if (!conversation) throw new ConversationGoneError();
  rc.conversation = conversation;
  rc.bots.clear();
  for (const bot of allBots) rc.bots.set(bot.id, bot);
  rc.members.clear();
  for (const member of conversation.members) rc.members.add(member.bot_id);
}

/**
 * - `run`: everything, member messages and wake-ups included;
 * - `writes`: this run may not start more turns — stop at the first item that
 *   needs one, so it (and everything after it) waits for the next run in order;
 * - `stop`: after a member Stop — write events and wake-ups' lines but never
 *   run a Bot; stop at the first member message (answered by the next run).
 */
type DrainMode = 'run' | 'writes' | 'stop';

interface DrainResult {
  /** A member message was delivered: the current chain ends, a new one starts. */
  interjection?: Extract<ChainTrigger, { kind: 'message' }>;
  wrote: boolean;
}

/** Drain the conversation's inbox in id order (see the module comment). */
async function drainInbox(
  rc: RunContext,
  onContinue: (botId: string, note: string) => void,
  mode: DrainMode,
): Promise<DrainResult> {
  const rows = await rc.db.bots.listPendingInbox(rc.sessionId);
  let wrote = false;
  for (const row of rows) {
    if (isTrigger(row) && mode === 'writes') break;
    if (row.kind === 'user_message' && mode === 'stop') break;
    const item = parseInboxRow(row);
    if (!item) {
      await quarantineMalformed(rc.db, rc.sessionId, row);
      continue;
    }
    const outcome = await applyInboxRow(rc.db, rc.writer, row, item);
    // A failed item blocks the ones after it, so order is preserved; the next drain retries.
    if (outcome === 'failed') break;
    if (outcome === 'taken' || outcome === 'quarantined') continue;
    wrote = true;
    if (item.kind === 'user_message') {
      // Before any turn ran (a server-initiated run opened for this message) it is
      // an ordinary message, not an interjection into Bots at work.
      const reason = rc.turnCounter === 0 ? 'user' : 'interjection';
      return { interjection: { kind: 'message', reason, mentions: item.mentions ?? [] }, wrote };
    }
    // A Bot joined / left / was created: the wake-up below and the queued turns see it.
    if (changesRoster(item)) await refreshRoster(rc);
    if (item.kind !== 'continue') continue;
    if (mode === 'stop') {
      const name = rc.bots.get(item.botId)?.name ?? item.botId;
      await rc.writer.appendEvent({
        text: copy.stoppedWakeup(rc.user.locale, name),
        event: { kind: 'stopped', bot_id: item.botId },
        botId: item.botId,
        messageId: inboxMessageId(row.id, ':stopped'),
      });
    } else onContinue(item.botId, item.note);
  }
  return { wrote };
}

function isActiveMember(rc: RunContext, botId: string | null | undefined): botId is string {
  return Boolean(botId) && rc.members.has(botId!) && rc.bots.get(botId!)?.status === 'active';
}

function ownersFor(
  rc: RunContext,
  trigger: ChainTrigger,
): Array<{ botId: string; reason: FloorItem['reason']; message?: string }> {
  if (trigger.kind === 'continue') {
    return trigger.items.map((item) => ({ botId: item.botId, reason: 'continue' as const, message: item.note }));
  }
  const mentioned = trigger.mentions.filter((id) => isActiveMember(rc, id));
  if (mentioned.length > 0) {
    return mentioned.map((botId) => ({
      botId,
      reason: trigger.reason === 'interjection' ? 'interjection' : 'mention',
    }));
  }
  const conversation = rc.conversation;
  // A DM is its owner's: when the owner is archived nobody answers there (its
  // guests only speak when addressed). A group falls back from its lead to
  // the first active member.
  const fallback =
    conversation.kind === 'direct'
      ? isActiveMember(rc, conversation.owner_bot_id)
        ? conversation.owner_bot_id
        : null
      : isActiveMember(rc, conversation.lead_bot_id)
        ? conversation.lead_bot_id
        : (conversation.members.find((m) => isActiveMember(rc, m.bot_id))?.bot_id ?? null);
  return fallback ? [{ botId: fallback, reason: trigger.reason }] : [];
}

/** Nobody can answer a member message: a line in the transcript instead of a silent, empty run. */
async function writeUnavailable(rc: RunContext): Promise<void> {
  const conversation = rc.conversation;
  if (conversation.kind === 'direct') {
    const owner = conversation.owner_bot_id ? rc.bots.get(conversation.owner_bot_id) : undefined;
    await rc.writer.appendEvent({
      text: copy.botArchived(rc.user.locale, owner?.name ?? '?'),
      event: { kind: 'unavailable', bot_id: owner?.id ?? null, reason: 'archived' },
    });
    return;
  }
  await rc.writer.appendEvent({
    text: copy.noActiveMembers(rc.user.locale),
    event: { kind: 'unavailable', bot_id: null, reason: 'no_active_members' },
  });
}

async function writeLimit(rc: RunContext, chain: ChainState, reason: LimitReason): Promise<void> {
  if (chain.limit) return;
  chain.limit = reason;
  chain.floor.hitLimit();
  await rc.writer.appendEvent({ text: copy.limit(rc.user.locale, reason), event: { kind: 'limit', reason } });
}

/**
 * Take the member's soft stop (see the module comment) once the turn that was
 * running has finished its step. `dropped` are the wake-ups the chain had
 * planned but not run. A queued member message starts the next chain, those
 * wake-ups carried after it as for any interjection; with none the run ends:
 * queued wake-ups are written but not run, and dropped ones say so, as after
 * a Stop. Throws RunInterruptedError to end the run.
 */
async function takeInterrupt(rc: RunContext, dropped: WakeUp[]): Promise<ChainTrigger> {
  rc.run.clearInterrupt();
  const carry = [...dropped];
  if (await memberMessageQueued(rc.db, rc.sessionId)) {
    const drained = await drainInbox(rc, (botId, note) => carry.push({ botId, note }), 'run');
    if (drained.interjection) {
      return { ...drained.interjection, carry: [...(drained.interjection.carry ?? []), ...carry] };
    }
    // The message could not be applied: it stays queued and the next run answers it.
  }
  await drainInbox(rc, () => undefined, 'stop');
  for (const wake of carry) {
    const name = rc.bots.get(wake.botId)?.name ?? wake.botId;
    await rc.writer.appendEvent({
      text: copy.stoppedWakeup(rc.user.locale, name),
      event: { kind: 'stopped', bot_id: wake.botId },
      botId: wake.botId,
    });
  }
  throw new RunInterruptedError();
}

/** Run one chain. Returns the next trigger when a member message interrupted it. */
async function runChain(rc: RunContext, trigger: ChainTrigger): Promise<ChainTrigger | null> {
  // Answering a member message is what a soft stop asked for (or came
  // before it): it applies to the work after this point, not to the answer.
  if (trigger.kind === 'message') rc.run.clearInterrupt();
  await refreshRoster(rc);
  const floor = new FloorController({
    members: rc.members,
    allowBotChat: () => rc.conversation.allow_bot_chat,
    turnBudget: Math.min(CHAIN_LIMITS.turns, CHAIN_LIMITS.runTurns - rc.turnCounter),
  });
  const owners = ownersFor(rc, trigger);
  floor.start(owners);
  if (trigger.kind === 'message') {
    if (owners.length === 0) await writeUnavailable(rc);
    // Carried wake-ups run after the addressees. A Bot that answers the message
    // anyway sees its hand-back line in the history, so it gets no second turn.
    const addressed = new Set(owners.map((owner) => owner.botId));
    for (const wake of trigger.carry ?? []) {
      if (!addressed.has(wake.botId)) floor.addContinue(wake.botId, wake.note);
    }
  }
  const chain: ChainState = {
    floor,
    deadline: Date.now() + CHAIN_LIMITS.wallClockMs,
    inputWeighted: 0,
    output: 0,
    steps: 0,
    limit: null,
    outcomes: new Map(),
  };

  for (;;) {
    if (rc.run.signal.aborted) throw new RunAbortError();
    // Soft stop: the Bot that was speaking finished its step; nothing planned runs.
    if (rc.run.interruptRequested) return await takeInterrupt(rc, floor.clear());
    // After a budget hit only the reserved follow-ups run: new turns wait in the
    // inbox for a fresh chain (the final drain of the run starts one).
    const drained = await drainInbox(
      rc,
      (botId, note) => floor.addContinue(botId, note),
      !chain.limit && rc.turnCounter < CHAIN_LIMITS.runTurns ? 'run' : 'writes',
    );
    if (drained.interjection) {
      const carried = floor.clear();
      return { ...drained.interjection, carry: [...(drained.interjection.carry ?? []), ...carried] };
    }
    // The next turn runs against the current roster (a Bot archived or removed
    // meanwhile is skipped; one invited meanwhile is a valid hand-off target).
    await refreshRoster(rc);
    const item = floor.next();
    if (item === null) return null;
    if (item === 'turns') {
      await writeLimit(rc, chain, 'turns');
      continue;
    }
    if (item.reason !== 'followup') {
      if (!chain.limit) {
        if (Date.now() >= chain.deadline) await writeLimit(rc, chain, 'wall_clock');
        else if (chain.steps >= CHAIN_LIMITS.steps) await writeLimit(rc, chain, 'steps');
      }
      // Once limited, nothing but a reserved follow-up may start a turn.
      if (chain.limit) continue;
    }
    const result = await runBotTurn(rc, chain, item);
    if (result.transcriptChanged) throw new TranscriptChangedError(rc.sessionId);
    chain.outcomes.set(item.botId, result.status);
    floor.endTurn();
    if (rc.run.signal.aborted) throw new RunAbortError();
    if (result.limit) await writeLimit(rc, chain, result.limit);
  }
}

async function finishRun(
  db: DatabaseProvider,
  run: ChatRun,
  rc: RunContext | null,
  userId: string,
  status: 'completed' | 'error',
): Promise<void> {
  if (!rc) {
    // The run could not even load (conversation gone, owner disabled): tell the
    // attached client plainly instead of ending with an empty finish.
    run.emit({ type: 'error', error: 'This conversation is not available.' });
  } else {
    run.emit({
      type: 'finish',
      finishReason: status === 'completed' ? 'stop' : 'error',
      usage: {
        inputTokens: rc.usage.input,
        outputTokens: rc.usage.output,
        totalTokens: rc.usage.input + rc.usage.output,
        cachedInputTokens: rc.usage.cached,
        reasoningTokens: rc.usage.reasoning,
      },
    });
  }
  // The cross-process lock goes first: once the in-process slot is free a new
  // claim here must be able to take the lock again.
  if (run.sessionId) await unlockBotsRun(db, run.sessionId);
  chatRunRegistry.finish(run, status);
  if (run.sessionId) {
    connectionManager.sendToUser(userId, { type: 'chat:run', sessionId: run.sessionId, runId: run.runId, status });
  }
}

async function loadRunContext(args: BotsRunArgs, db: DatabaseProvider): Promise<RunContext> {
  const [session, user, conversation] = await Promise.all([
    db.sessions.getById(args.sessionId),
    db.users.getById(args.userId),
    db.bots.getConversation(args.userId, args.sessionId),
  ]);
  if (!session || session.user_id !== args.userId || session.channel !== 'bots') {
    throw new Error('Bots conversation not found for its owner');
  }
  // Same rule as every entry point (run-slot.ts): active, internal, `bots` on.
  // The role check is repeated for the type narrowing below.
  if (!user || (user.role !== 'team' && user.role !== 'super') || !(await botsOwnerEligible(db, user))) {
    throw new Error('The conversation owner may not run Bots');
  }
  if (!conversation || conversation.user_id !== args.userId) throw new Error('Bots conversation not found');
  const locale = botsLocale(user.locale);
  const allBots = await db.bots.listBots(user.id, { includeArchived: true });
  const bots = new Map(allBots.map((bot) => [bot.id, bot]));

  // Digest snapshot for the whole run, with the boundary self-check: the
  // boundary row must still exist and be inside the transcript.
  let uptoSeq = effectiveDigestUpto(conversation);
  let stored = conversation.digest;
  const latest = await db.sessions.getLatestMessage(args.sessionId);
  if (uptoSeq >= 0) {
    const boundary = conversation.digest_upto_message_id
      ? await db.sessions.getMessageById(conversation.digest_upto_message_id)
      : undefined;
    if (!boundary || boundary.session_id !== args.sessionId || !latest || latest.seq < uptoSeq) {
      logger.warn('[bots] digest boundary is gone — resetting the digest', { sessionId: args.sessionId });
      await db.bots.resetDigest(args.sessionId);
      uptoSeq = -1;
      stored = '';
    }
  }
  const botNames = new Map(allBots.map((bot) => [bot.id, bot.name]));
  const digest = digestView(stored, uptoSeq, conversation.digest_updated_at, locale, botNames);

  const profile = await botsEngineDeps().resolveProfile('sprouty');
  const { effectiveTools } = await resolveEffectiveTools({
    userId: user.id,
    userRole: user.role,
    profile,
    profileId: 'sprouty',
  });
  return {
    run: args.run,
    db,
    toolRegistry: args.toolRegistry,
    user: { id: user.id, role: user.role, nickname: user.nickname, notes: user.notes ?? null, locale },
    sessionId: args.sessionId,
    conversation,
    members: new Set(conversation.members.map((m) => m.bot_id)),
    bots,
    writer: new TranscriptWriter(db, args.sessionId, latest ?? null),
    digest: { rendered: digest?.text ?? null, uptoSeq },
    effectiveTools,
    profile,
    triggerKey: args.triggerKey,
    turnCounter: 0,
    usage: { input: 0, output: 0, cached: 0, reasoning: 0 },
    startedAt: Date.now(),
  };
}

/** The divider line after a compaction goes through the single writer too. */
function scheduleDigest(sessionId: string, userId: string): void {
  scheduleDigestCheck(sessionId, async (uptoSeq, locale) => {
    const { deliverToConversation } = await import('./inbox.js');
    await deliverToConversation(sessionId, {
      kind: 'event',
      text: copy.digest(locale),
      event: { kind: 'digest', upto_seq: uptoSeq },
    });
    connectionManager.sendToUser(userId, { type: 'bots:conversation', sessionId });
  });
}

/** After a member Stop: record queued events and wake-ups without running anyone. Never throws. */
async function drainAfterStop(rc: RunContext): Promise<void> {
  try {
    await drainInbox(rc, () => undefined, 'stop');
  } catch (error) {
    // A foreign write or a DB error: the rows stay queued for the sweeper.
    logger.warn('[bots] draining after Stop failed', { sessionId: rc.sessionId, error: toErrorMessage(error) });
  }
}

/**
 * Drive a claimed run to its end. Never throws; always finishes the run
 * (exactly one `finish`), releases the run lock and the slot, pushes
 * `chat:run`, touches the conversation and schedules the digest check.
 */
export async function runBotsRun(args: BotsRunArgs): Promise<BotsRunOutcome> {
  const db = args.db ?? getDb();
  const { run, userId, sessionId } = args;
  connectionManager.sendToUser(userId, { type: 'chat:run', sessionId, runId: run.runId, status: 'running' });
  let rc: RunContext | null = null;
  let status: 'completed' | 'error' = 'completed';
  try {
    rc = await loadRunContext(args, db);
    let trigger: ChainTrigger | null = args.trigger;
    while (trigger) {
      trigger = await runChain(rc, trigger);
      if (trigger) continue;
      // Before finishing: anything that arrived during the last turn.
      if (rc.run.signal.aborted) break;
      if (rc.run.interruptRequested) {
        trigger = await takeInterrupt(rc, []);
        continue;
      }
      const pending: WakeUp[] = [];
      const drained = await drainInbox(
        rc,
        (botId, note) => pending.push({ botId, note }),
        rc.turnCounter < CHAIN_LIMITS.runTurns ? 'run' : 'writes',
      );
      if (drained.interjection) {
        trigger = { ...drained.interjection, carry: [...(drained.interjection.carry ?? []), ...pending] };
      } else if (pending.length > 0) trigger = { kind: 'continue', items: pending };
    }
  } catch (error) {
    if (error instanceof RunAbortError) {
      // Member Stop / shutdown: completed turns stay (the Stop drain is below).
    } else if (error instanceof RunInterruptedError) {
      // Soft stop with nobody waiting: the run ends normally (takeInterrupt drained it).
    } else if (error instanceof ConversationGoneError) {
      logger.info('[bots] conversation deleted during a run', { sessionId });
    } else {
      status = 'error';
      logger.error('[bots] run failed', { sessionId, error: toErrorMessage(error) });
    }
  }
  // Stop means stop: queued wake-ups (a hand-back, a joined Bot) are written but
  // never run; queued member messages stay and are answered right below. A
  // shutdown keeps everything queued for the next process.
  if (rc && run.stopReason === 'user') await drainAfterStop(rc);
  await finishRun(db, run, rc, userId, status);
  if (!rc) return { status, loaded: false };
  await db.bots.touchActivity(sessionId).catch(() => undefined);
  connectionManager.sendToUser(userId, { type: 'bots:conversation', sessionId });
  scheduleDigest(sessionId, userId);
  // Work left queued (a member message after Stop or after the run's turn cap,
  // a wake-up that arrived after the last drain): answer it now instead of at
  // the next sweep. Never after a failed run (no retry loop) or a shutdown.
  if (status === 'completed' && run.stopReason !== 'shutdown' && run.stopReason !== 'account-security') {
    const left = await db.bots.listPendingInbox(sessionId).catch(() => []);
    if (left.length > 0) {
      const { drainIdleConversation } = await import('./inbox.js');
      void drainIdleConversation(sessionId, db).catch(() => undefined);
    }
  }
  return { status, loaded: true };
}
