/**
 * The member's Agents from outside Greenhouse (spec 20261011-agent-first-class P6, D48–D54).
 *
 * One service for every outside channel — an MCP client, the CLI, a Feishu thread — so they all
 * reach the same engine under the same rules:
 * - who can be reached: the member's own Agents (the main one included) and the public Agents
 *   offered to them (`publicBotFor`);
 * - where the exchange lives: a new task chat with an own Agent, the member's DM with a public
 *   one — both in the member's list, the first line naming the channel (`external_origin`);
 * - how long to wait: up to `waitMs`, then the conversation is the handle to read later;
 * - what needs the member: cards (approvals, sign-ins) stay in the app — the result says so and
 *   links there. Replies are plain markdown: the other side cannot draw Rich Output blocks.
 */

import { getDb, type BotRow, type DatabaseProvider } from '@greenhouse/db';
import type { MessageRow } from '@greenhouse/types/session';
import { isSproutyBot, type BotEvent } from '@greenhouse/types/bots';
import { safeJsonParse } from '@greenhouse/utils/json';
import { chatRunRegistry } from '../../chat/runs.js';
import { connectionManager } from '../../ws/connection-manager.js';
import { botsLocale, copy } from '../engine/copy.js';
import { writeGreeting } from '../engine/greeting.js';
import { conversationReplyState, deliverToConversation, startBotsChain } from '../engine/index.js';
import { engineToolRegistry } from '../engine/inbox.js';
import { botsOwnerEligible, claimBotsRun, releaseBotsRun } from '../engine/run-slot.js';
import { listPublicBotsFor, publicBotFor } from '../public.js';
import { ensureSproutyBot } from '../sprouty.js';

/** A member message from outside, like one typed in the composer. */
export const EXTERNAL_MESSAGE_MAX_CHARS = 8_000;
/** How much of a transcript one read looks at. */
const READ_WINDOW = 100;

export type ReachableAgentKind = 'main' | 'own' | 'public';

export interface ReachableAgent {
  id: string;
  name: string;
  role: string;
  description: string;
  kind: ReachableAgentKind;
  /** A public Agent's owner (their nickname); null for the member's own. */
  owner: string | null;
}

/** Who is calling from outside: named on the conversation's first line. */
export interface ExternalCaller {
  /** e.g. "Claude Code", "Feishu", "Greenhouse CLI". */
  label: string;
}

export type ExchangeStatus = 'answered' | 'working' | 'needs_you';

export interface AgentReply {
  message_id: string;
  agent_id: string;
  agent: string;
  text: string;
  created_at: string;
}

export interface AgentExchange {
  conversation_id: string;
  agent: { id: string; name: string };
  status: ExchangeStatus;
  replies: AgentReply[];
  /** Cards waiting for the member in the Greenhouse app (approvals, sign-ins, proposals). */
  needs_you: Array<{ kind: string; summary: string }>;
  /** Lines the engine wrote after the message: a limit reached, an Agent unavailable, a failed turn. */
  notes: string[];
  /** The conversation in the Greenhouse app (when PUBLIC_BASE_URL is set). */
  url: string | null;
}

export class AgentAccessError extends Error {
  constructor(
    readonly code: 'not_enabled' | 'not_found' | 'unavailable' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AgentAccessError';
  }
}

export function conversationUrl(sessionId: string): string | null {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/#/bots?c=${encodeURIComponent(sessionId)}` : null;
}

async function assertEligible(db: DatabaseProvider, userId: string) {
  const user = await db.users.getById(userId);
  if (!user || !(await botsOwnerEligible(db, user))) {
    throw new AgentAccessError('not_enabled', 'Agents are not enabled for this account');
  }
  return user;
}

function kindOf(bot: BotRow, userId: string): ReachableAgentKind {
  if (bot.user_id !== userId) return 'public';
  return isSproutyBot(bot) ? 'main' : 'own';
}

function view(bot: BotRow, kind: ReachableAgentKind, owner: string | null): ReachableAgent {
  return { id: bot.id, name: bot.name, role: bot.role, description: bot.description ?? '', kind, owner };
}

/** Every Agent this member can reach: their main Agent first, their other Agents, then public ones. */
export async function listReachableAgents(db: DatabaseProvider, userId: string): Promise<ReachableAgent[]> {
  await assertEligible(db, userId);
  const main = await ensureSproutyBot(db, userId);
  const own = (await db.bots.listBots(userId)).filter((bot) => bot.id !== main.id);
  const owners = new Map<string, string>();
  const shared: ReachableAgent[] = [];
  for (const bot of await listPublicBotsFor(db, userId)) {
    if (!owners.has(bot.user_id)) {
      const owner = await db.users.getById(bot.user_id);
      owners.set(bot.user_id, owner?.nickname || owner?.email || '');
    }
    shared.push(view(bot, 'public', owners.get(bot.user_id) ?? null));
  }
  return [view(main, 'main', null), ...own.map((bot) => view(bot, 'own', null)), ...shared];
}

/** One reachable Agent by id (`main` or nothing = the main Agent). */
async function reachableAgent(db: DatabaseProvider, userId: string, agentId: string | undefined): Promise<BotRow> {
  if (!agentId || agentId === 'main') return ensureSproutyBot(db, userId);
  const own = await db.bots.getBot(userId, agentId);
  if (own) {
    if (own.status !== 'active') throw new AgentAccessError('unavailable', 'That Agent was archived');
    return own;
  }
  const shared = await publicBotFor(db, userId, agentId);
  if (shared) return shared;
  throw new AgentAccessError('not_found', 'No Agent with that id is available to you — see agents_list');
}

/**
 * The reachable Agent whose name starts `text` (case-insensitive; the longest name wins, so
 * "Sage Pro" beats "Sage"), and the text after it. Used by channels that address an Agent by
 * name, like a Feishu message starting `@Sage …`.
 */
export async function matchAgentByName(
  db: DatabaseProvider,
  userId: string,
  text: string,
): Promise<{ agent: ReachableAgent; rest: string } | null> {
  const lower = text.toLowerCase();
  const agents = (await listReachableAgents(db, userId)).sort((a, b) => b.name.length - a.name.length);
  for (const agent of agents) {
    const name = agent.name.toLowerCase();
    if (!name || !lower.startsWith(name)) continue;
    const after = text.slice(agent.name.length);
    // A whole name, not the start of a longer word ("Sage" must not match "Sagebrush").
    if (after && !/^[\s,，:：]/.test(after)) continue;
    return { agent, rest: after.replace(/^[\s,，:：]+/, '').trim() };
  }
  return null;
}

/** The Agent a conversation of this member belongs to, as they may use it now. */
async function agentOfConversation(db: DatabaseProvider, userId: string, ownerBotId: string | null): Promise<BotRow> {
  if (!ownerBotId) throw new AgentAccessError('unavailable', 'Nobody answers in that conversation');
  const own = await db.bots.getBot(userId, ownerBotId);
  if (own) return own;
  const shared = await publicBotFor(db, userId, ownerBotId);
  if (shared) return shared;
  throw new AgentAccessError('unavailable', 'That Agent is no longer available to you');
}

const NOTE_EVENTS: ReadonlySet<BotEvent['kind']> = new Set(['limit', 'unavailable', 'turn_error', 'stopped']);

function eventOf(row: Pick<MessageRow, 'bot_event'>): BotEvent | null {
  if (!row.bot_event) return null;
  return safeJsonParse(row.bot_event, null) as BotEvent | null;
}

/** An Agent's name as this member sees it: their own, or a public one's published name. */
async function agentName(db: DatabaseProvider, userId: string, botId: string): Promise<string> {
  const bot =
    (await db.bots.getBot(userId, botId)) ??
    (await publicBotFor(db, userId, botId)) ??
    (await db.bots.getBotById(botId));
  return bot?.name ?? '';
}

/**
 * The caller's name as the member reads it on the conversation's first line. An MCP client picks
 * its own name when it registers, so it is plain text here: one line, no markdown, short.
 */
export function callerLabel(raw: string): string {
  const clean = raw
    .replace(/\s+/g, ' ')
    .replace(/[[\]()*_`<>#|!\\]/g, '')
    .trim()
    .slice(0, 60)
    .trim();
  return clean || 'an outside app';
}

function summaryOf(payload: string): string {
  const p = safeJsonParse(payload, {}) as Record<string, unknown>;
  for (const key of ['summary', 'title', 'reason', 'name']) {
    const value = p[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * A conversation's state as an outside caller sees it: replies after `afterSeq` (default: after
 * the last member message), the cards waiting for the member, and whether it is still working.
 */
export async function readExchange(
  db: DatabaseProvider,
  userId: string,
  sessionId: string,
  opts: { afterSeq?: number; afterMessageId?: string } = {},
): Promise<AgentExchange> {
  const conversation = await db.bots.getConversation(userId, sessionId);
  if (!conversation || (conversation.kind !== 'task' && conversation.kind !== 'direct')) {
    throw new AgentAccessError('not_found', 'No such conversation of yours');
  }
  const page = await db.sessions.getMessagePage(sessionId, { limit: READ_WINDOW });
  let after = opts.afterSeq;
  if (after === undefined && opts.afterMessageId) {
    const anchor = await db.sessions.getMessageById(opts.afterMessageId);
    if (!anchor || anchor.session_id !== sessionId) {
      throw new AgentAccessError('invalid', 'after_message_id is not a message of this conversation');
    }
    after = anchor.seq;
  }
  if (after === undefined) {
    const lastMember = [...page.messages].reverse().find((row) => row.role === 'user');
    after = lastMember?.seq ?? -1;
  }
  const names = new Map<string, string>();
  const nameOf = async (botId: string) => {
    if (!names.has(botId)) names.set(botId, await agentName(db, userId, botId));
    return names.get(botId)!;
  };
  const replies: AgentReply[] = [];
  const notes: string[] = [];
  for (const row of page.messages) {
    if (row.seq <= after!) continue;
    const event = eventOf(row);
    if (row.role === 'assistant' && row.bot_id && event?.kind !== 'greeting') {
      replies.push({
        message_id: row.id,
        agent_id: row.bot_id,
        agent: await nameOf(row.bot_id),
        text: row.content,
        created_at: row.created_at,
      });
    } else if (row.role === 'system' && event && NOTE_EVENTS.has(event.kind)) {
      notes.push(row.content);
    }
  }
  const pending = await db.bots.listRequests(userId, { sessionId, status: 'pending' });
  const working =
    Boolean(chatRunRegistry.getActive(sessionId)) || (await db.bots.listPendingInbox(sessionId)).length > 0;
  return {
    conversation_id: sessionId,
    agent: {
      id: conversation.owner_bot_id ?? '',
      name: conversation.owner_bot_id ? await nameOf(conversation.owner_bot_id) : '',
    },
    status: pending.length > 0 ? 'needs_you' : working ? 'working' : 'answered',
    replies,
    needs_you: pending.map((request) => ({ kind: request.kind, summary: summaryOf(request.payload) })),
    notes,
    url: conversationUrl(sessionId),
  };
}

/** Read a conversation for an outside caller (`agent_conversation_get`). */
export async function readAgentConversation(input: {
  db?: DatabaseProvider;
  userId: string;
  conversationId: string;
  afterMessageId?: string;
}): Promise<AgentExchange> {
  const db = input.db ?? getDb();
  await assertEligible(db, input.userId);
  return readExchange(db, input.userId, input.conversationId, { afterMessageId: input.afterMessageId });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Send a member message to an Agent from outside and wait up to `waitMs` for its answer.
 * Without `conversationId`: a new task chat with an own Agent, or the member's DM with a public
 * one, opened with a line naming `caller`. With it: that conversation (it must be the member's
 * task chat or DM, and with `agentId` when one is given).
 */
export async function askAgent(input: {
  db?: DatabaseProvider;
  userId: string;
  agentId?: string;
  conversationId?: string;
  message: string;
  caller: ExternalCaller;
  waitMs: number;
}): Promise<AgentExchange> {
  const db = input.db ?? getDb();
  const user = await assertEligible(db, input.userId);
  const message = input.message.trim();
  if (!message) throw new AgentAccessError('invalid', 'message is empty');
  if (message.length > EXTERNAL_MESSAGE_MAX_CHARS) {
    throw new AgentAccessError('invalid', `message is longer than ${EXTERNAL_MESSAGE_MAX_CHARS} characters`);
  }
  const locale = botsLocale(user.locale);

  let sessionId: string;
  let opened = false;
  if (input.conversationId) {
    const conversation = await db.bots.getConversation(user.id, input.conversationId);
    if (!conversation || (conversation.kind !== 'task' && conversation.kind !== 'direct')) {
      throw new AgentAccessError('not_found', 'No such conversation of yours');
    }
    if (input.agentId && input.agentId !== 'main' && conversation.owner_bot_id !== input.agentId) {
      throw new AgentAccessError('invalid', 'That conversation is with another Agent');
    }
    await agentOfConversation(db, user.id, conversation.owner_bot_id);
    sessionId = conversation.session_id;
  } else {
    const bot = await reachableAgent(db, user.id, input.agentId);
    if (kindOf(bot, user.id) === 'public') {
      const dm = await db.bots.ensureDirectConversation(user.id, bot.id, { public: true });
      await writeGreeting(db, dm.session_id, bot, undefined, user.id);
      sessionId = dm.session_id;
    } else {
      sessionId = (await db.bots.createTaskConversation(user.id, bot.id)).session_id;
    }
    opened = true;
    connectionManager.sendToUser(user.id, { type: 'bots:conversation', sessionId });
  }

  const state = await conversationReplyState(db, user.id, sessionId);
  if (state !== 'ok') throw new AgentAccessError('unavailable', 'That conversation is read-only now');

  const session = await db.sessions.getById(sessionId);
  if (!session) throw new AgentAccessError('not_found', 'No such conversation of yours');
  const run = await claimBotsRun(db, sessionId, user.id);
  if (!run) {
    // Busy (here or on another API slot): the running chain reads it between turns.
    const before = (await db.sessions.getLatestMessage(sessionId))?.seq ?? -1;
    await deliverToConversation(sessionId, { kind: 'user_message', content: message, mentions: [] });
    return readExchange(db, user.id, sessionId, { afterSeq: before });
  }
  let before: number;
  try {
    // The first line says where this exchange came from (we hold the slot: nobody else writes).
    if (opened) {
      await db.sessions.addMessage({
        session_id: sessionId,
        role: 'system',
        content: copy.externalOrigin(locale, callerLabel(input.caller.label)),
        bot_event: JSON.stringify({ kind: 'external_origin', via: callerLabel(input.caller.label) } satisfies BotEvent),
      });
    }
    before = (await db.sessions.getLatestMessage(sessionId))?.seq ?? -1;
    await startBotsChain({
      authUser: { id: user.id, role: user.role, nickname: user.nickname },
      session,
      toolRegistry: engineToolRegistry() ?? {},
      run,
      message: { content: message, mentions: [] },
      db,
      // The caller reads plain text: no cards, charts or previews it cannot draw.
      richBlocks: [],
    });
  } catch (error) {
    await releaseBotsRun(db, run);
    throw error;
  }
  await Promise.race([run.ended, sleep(input.waitMs)]);
  return readExchange(db, user.id, sessionId, { afterSeq: before });
}
