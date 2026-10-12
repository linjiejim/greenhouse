/** Agent request/return reuses the durable inbox and conversation run slots. */
import type { BotAgentMessageRow, DatabaseProvider } from '@greenhouse/db';
import { listPublicBotsFor, publicBotFor } from '../public.js';
import { roomGuestBot } from '../room-access.js';
import type { BotTurnContext } from './context.js';
import { botsOwnerEligible } from './run-slot.js';
import { pushToConversation } from './fanout.js';

export async function directMessageTargets(ctx: BotTurnContext) {
  const own = (await ctx.db.bots.listBots(ctx.userId)).filter((bot) => bot.status === 'active');
  const publicBots = await listPublicBotsFor(ctx.db, ctx.userId);
  return [...new Map([...own, ...publicBots].map((bot) => [bot.id, bot])).values()];
}

export async function sendAgentMessage(
  ctx: BotTurnContext,
  input: {
    ref: string;
    body: string;
    dedupeKey: string;
    chainKey: string;
    parentId?: string;
  },
) {
  const targets = await directMessageTargets(ctx);
  const key = input.ref.trim().replace(/^@/, '').toLowerCase();
  const target = targets.find((bot) => bot.id === input.ref);
  const named = targets.filter((bot) => bot.name.toLowerCase() === key);
  const chosen = target ?? (named.length === 1 ? named[0] : undefined);
  if (!chosen) return { status: 'refused', reason: 'Target is unavailable or ambiguous. Use an id from team.list.' };
  const row = await ctx.db.bots.createAgentMessage({
    dedupeKey: input.dedupeKey,
    chainKey: input.chainKey,
    parentId: input.parentId,
    requesterId: ctx.userId,
    sourceSessionId: ctx.sessionId,
    sourceBotId: ctx.bot.id,
    targetBotId: chosen.id,
    body: input.body,
    public: chosen.user_id !== ctx.userId,
  });
  ctx.stopAfterStep('handoff');
  // Already durable: a process exit here is recovered by the existing inbox sweep.
  const { drainIdleConversation } = await import('./inbox.js');
  void drainIdleConversation(row.target_session_id, ctx.db);
  await pushToConversation(
    row.target_session_id,
    ctx.userId,
    { type: 'bots:conversation', sessionId: row.target_session_id },
    ctx.db,
  );
  return {
    status: 'sent',
    id: row.id,
    to: chosen.name,
    conversation_id: row.target_session_id,
    note: 'End your turn. The recipient answers in a separate conversation; its reply returns here and wakes you once. Do not poll or pretend it has replied.',
  };
}

async function available(db: DatabaseProvider, row: BotAgentMessageRow): Promise<boolean> {
  if (!(await botsOwnerEligible(db, await db.users.getById(row.requester_id)))) return false;
  const source = await db.bots.getConversation(row.requester_id, row.source_session_id);
  if (!source?.members.some((member) => member.bot_id === row.source_bot_id)) return false;
  const sender = await db.bots.getBotById(row.source_bot_id);
  if (!sender || sender.status !== 'active') return false;
  if (sender.user_id !== row.requester_id && !(await publicBotFor(db, row.requester_id, sender.id))) {
    const member = source.members.find((m) => m.bot_id === sender.id);
    if (source.kind !== 'room' || !member || !(await roomGuestBot(db, member))) return false;
  }
  const target = await db.bots.getBotById(row.target_bot_id);
  if (!target || target.status !== 'active') return false;
  return target.user_id === row.requester_id || (await publicBotFor(db, row.requester_id, target.id)) !== null;
}

async function returnResult(
  db: DatabaseProvider,
  row: BotAgentMessageRow,
  status: 'answered' | 'failed',
  text: string,
) {
  const source = await db.bots.returnAgentMessage(row.id, status, text);
  if (source) {
    const { drainIdleConversation } = await import('./inbox.js');
    void drainIdleConversation(source, db);
    await pushToConversation(source, row.requester_id, { type: 'bots:conversation', sessionId: source }, db);
  }
}

/** Recheck authorization at actual execution, after any time spent queued. */
export async function startAgentMessage(db: DatabaseProvider, sessionId: string): Promise<boolean> {
  const row = await db.bots.agentMessageForTarget(sessionId);
  if (!row) return true;
  if (row.returned_at) {
    // Expired/revoked work must never run later if it was still queued at return time.
    for (const queued of await db.bots.listPendingInbox(sessionId)) {
      const item = JSON.parse(queued.payload) as { kind?: string; exchangeId?: string };
      if (item.kind === 'continue' && item.exchangeId === row.id) await db.bots.consumeInbox(queued.id);
    }
    return true;
  }
  if (!(await available(db, row))) {
    await returnResult(
      db,
      row,
      'failed',
      'Agent message could not run: the requester, sender or recipient is no longer available.',
    );
    return false;
  }
  await db.bots.startAgentMessage(row.id);
  return true;
}

export async function finishAgentMessage(db: DatabaseProvider, sessionId: string, failed: boolean): Promise<void> {
  const row = await db.bots.agentMessageForTarget(sessionId);
  if (!row || row.returned_at) return;
  // The child can return between the last inbox drain and this completion check.
  // Wait until the parent has actually consumed its result, not just until it returned.
  if (!failed) {
    const children = await db.bots.agentMessageChildren(row.id);
    if (children.some((child) => !child.returned_at)) return;
    const returned = new Set(children.map((child) => child.id));
    if (
      (await db.bots.listPendingInbox(sessionId)).some((queued) => {
        const item = JSON.parse(queued.payload) as { exchangeId?: string };
        return item.exchangeId && returned.has(item.exchangeId);
      })
    )
      return;
  }
  if (!(await available(db, row))) failed = true;
  const replies = (await db.sessions.getMessages(sessionId)).filter(
    (message) => message.role === 'assistant' && message.bot_id === row.target_bot_id,
  );
  const answer = replies.at(-1)?.content;
  await returnResult(
    db,
    row,
    !failed && answer ? 'answered' : 'failed',
    !failed && answer
      ? answer
      : 'Agent message did not complete. The Agent was stopped, unavailable, or failed to answer.',
  );
}

/** Crash recovery/timeout uses the same periodic sweep, with an idempotent return outbox. */
export async function sweepAgentMessages(db: DatabaseProvider): Promise<void> {
  for (const row of await db.bots.pendingAgentMessages()) {
    if (Date.now() - Date.parse(row.created_at) > 25 * 60_000 || !(await available(db, row))) {
      await returnResult(db, row, 'failed', 'Agent message expired or its access was revoked before completion.');
    }
  }
}
