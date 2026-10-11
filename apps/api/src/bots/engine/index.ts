/**
 * Bots engine — public surface. See docs/specs/20261005-personal-assistant-bots.md
 * §4 (conversation engine), §5 (tools), §7 (background tasks).
 *
 * - claimBotsRun + startBotsChain: the chat route claims the conversation's
 *   run (in-process slot + cross-process lock) and hands the member message
 *   here, which persists it — or queues it behind an older queued message —
 *   and runs the chain;
 * - conversationReplyState: whether anyone in the conversation can answer
 *   (a retired group chat / an archived DM owner → the route says 409);
 * - deliverToConversation: the single-writer entry for everything else
 *   (hand-backs, decided cards, task reports, busy-time member messages);
 * - initBotsEngine / shutdownBotsEngine: inbox sweeper + request expiry;
 * - createBotsRoutes: /api/bots.
 */

import type { AuthUser } from '../../auth/token.js';
import type { ToolRegistry } from '../../agent.js';
import type { ChatRun } from '../../chat/runs.js';
import type { SessionRow } from '@greenhouse/types/session';
import type { BotConversationReadOnlyCode } from '@greenhouse/types/bots';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { startRequestExpiryLoop, stopRequestExpiryLoop } from './approvals.js';
import { runBotsRun } from './chain.js';
import { publicBotFor } from '../public.js';
import {
  deliverToConversation as deliver,
  setInboxToolRegistry,
  startInboxSweeper,
  stopInboxSweeper,
} from './inbox.js';
import type { InboxItem } from './inbox-types.js';

export type { InboxItem } from './inbox-types.js';
export { createBotsRoutes } from '../routes.js';
export { cancelBotTasksForUser } from './tasks.js';
export { claimBotsRun, releaseBotsRun, stopBotsRunsForUser } from './run-slot.js';

export interface BotsMemberMessage {
  content: string;
  mentions: string[];
  images?: Array<{ id: string; url: string }>;
}

export interface StartBotsChainArgs {
  authUser: AuthUser;
  session: SessionRow;
  toolRegistry: ToolRegistry;
  /** Claimed by the chat route (claimBotsRun) before anything was written. */
  run: ChatRun;
  message: BotsMemberMessage;
  db?: DatabaseProvider;
  /** Rich Output blocks the member's screen can draw (`rich_blocks`); undefined = the default set. */
  richBlocks?: readonly string[];
}

function logCrash(sessionId: string) {
  return (error: unknown) => logger.error('[bots] chain crashed', { sessionId, error: toErrorMessage(error) });
}

/**
 * Persist a member message and run its chain inside an already-claimed run
 * (detached; the caller subscribes the HTTP response to the run). Always ends
 * the run once it returns; if it throws, nothing was started and the caller
 * releases the run.
 *
 * When an older member message or wake-up is still queued (the previous run
 * was stopped or hit its turn cap before answering it), this message queues
 * behind it instead of jumping ahead: the chain then writes and answers both
 * in the order they were sent, and the newer message — the later one — gets
 * the floor, so its @mentions are honoured.
 */
export async function startBotsChain(args: StartBotsChainArgs): Promise<void> {
  const db = args.db ?? getDb();
  const sessionId = args.session.id;
  const { content, mentions, images } = args.message;
  const pending = await db.bots.listPendingInbox(sessionId);
  const older = pending.find((row) => row.kind === 'user_message' || row.kind === 'continue');
  if (older) {
    await db.bots.enqueueInbox(sessionId, 'user_message', {
      kind: 'user_message',
      content,
      mentions,
      ...(images?.length ? { images } : {}),
    });
    void runBotsRun({
      run: args.run,
      userId: args.authUser.id,
      sessionId,
      toolRegistry: args.toolRegistry,
      trigger: { kind: 'continue', items: [] },
      triggerKey: `inbox-${older.id}`,
      db,
      richBlocks: args.richBlocks,
    }).catch(logCrash(sessionId));
    return;
  }
  const persisted = await db.sessions.addMessage({
    session_id: sessionId,
    role: 'user',
    content,
    ...(images?.length ? { images } : {}),
  });
  void runBotsRun({
    run: args.run,
    userId: args.authUser.id,
    sessionId,
    toolRegistry: args.toolRegistry,
    trigger: { kind: 'message', reason: 'user', mentions },
    triggerKey: persisted.id,
    db,
    richBlocks: args.richBlocks,
  }).catch(logCrash(sessionId));
}

export interface StartBotsRewindArgs extends Omit<StartBotsChainArgs, 'message'> {
  /** The member message the chat goes back to — the last one (checked by the caller). */
  messageId: string;
  /** Its new text (edit); undefined = the same text again (regenerate). */
  content?: string;
}

/**
 * Edit or regenerate in a task chat (spec 20261011-agent-first-class D23), inside an
 * already-claimed run: everything after the member's last message goes, its text changes when
 * edited, the rolling summary is reset when the cut reaches into it, and the chain answers it
 * again. Throws `RewindError` (nothing changed, the caller releases the run) when the message is
 * not the chat's last member message.
 */
export async function startBotsRewind(args: StartBotsRewindArgs): Promise<void> {
  const db = args.db ?? getDb();
  const sessionId = args.session.id;
  const target = await db.sessions.getMessageById(args.messageId);
  if (!target || target.session_id !== sessionId || target.role !== 'user') throw new RewindError('not_found');
  const recent = await db.sessions.getMessagePage(sessionId, { limit: 200 });
  const lastMember = [...recent.messages].reverse().find((row) => row.role === 'user');
  if (!lastMember || lastMember.id !== target.id) throw new RewindError('not_last');
  const content = args.content ?? target.content;
  const edited = await db.sessions.editUserMessageAndTruncate(sessionId, target.id, content);
  if (!edited.ok) throw new RewindError('not_found');
  const conversation = await db.bots.getConversation(args.authUser.id, sessionId);
  if (conversation && conversation.digest_upto_seq >= target.seq) await db.bots.resetDigest(sessionId);
  void runBotsRun({
    run: args.run,
    userId: args.authUser.id,
    sessionId,
    toolRegistry: args.toolRegistry,
    trigger: { kind: 'message', reason: 'user', mentions: [] },
    // A fresh key per attempt: the Runtime trace source of the earlier answer stays its own.
    triggerKey: `${target.id}~${args.run.runId}`,
    db,
    richBlocks: args.richBlocks,
  }).catch(logCrash(sessionId));
}

export class RewindError extends Error {
  constructor(readonly code: 'not_found' | 'not_last') {
    super(code === 'not_last' ? 'Only the last message can be edited or answered again' : 'Message not found');
  }
}

export type BotsReplyState = 'ok' | BotConversationReadOnlyCode;

/**
 * Can anyone answer a member message here? Group chats are retired: one is
 * readable history and takes no message (`group_closed`). A DM belongs to its
 * owner Bot: when that Bot is archived the conversation is read-only. The
 * route refuses with 409 rather than accepting a message nobody will answer
 * (the chain also writes a line as a backstop for an archived owner).
 */
export async function conversationReplyState(
  db: DatabaseProvider,
  userId: string,
  sessionId: string,
): Promise<BotsReplyState> {
  const [conversation, bots] = await Promise.all([
    db.bots.getConversation(userId, sessionId),
    db.bots.listBots(userId, { includeArchived: true }),
  ]);
  if (!conversation) return 'ok'; // the run reports a missing conversation itself
  if (conversation.kind === 'group') return 'group_closed';
  const ownerBotId = conversation.owner_bot_id;
  // Someone else's public Agent (P4): answerable while it is still offered to this member.
  if (ownerBotId && !bots.some((bot) => bot.id === ownerBotId)) {
    return (await publicBotFor(db, userId, ownerBotId)) ? 'ok' : 'agent_unavailable';
  }
  const active = new Set(bots.filter((bot) => bot.status === 'active').map((bot) => bot.id));
  return ownerBotId && active.has(ownerBotId) ? 'ok' : 'bot_archived';
}

/** Single-writer delivery into a Bots conversation (see inbox-types.ts). */
export async function deliverToConversation(sessionId: string, item: InboxItem): Promise<void> {
  await deliver(sessionId, item);
}

/** Boot: inbox sweeper, request expiry loop. */
export async function initBotsEngine(toolRegistry: ToolRegistry): Promise<void> {
  setInboxToolRegistry(toolRegistry);
  startInboxSweeper();
  startRequestExpiryLoop();
}

export async function shutdownBotsEngine(): Promise<void> {
  stopInboxSweeper();
  stopRequestExpiryLoop();
  setInboxToolRegistry(null);
}
