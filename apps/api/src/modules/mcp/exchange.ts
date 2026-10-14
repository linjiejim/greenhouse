/**
 * An outside caller talks to one of the member's Agents (AGNT-23): a message goes into that
 * Agent's thread exactly as if the member typed it (the engine decides when it is answered, and
 * every write the Agent wants still waits for the member's approval card in the app), then the
 * caller waits a while or comes back later to read what happened.
 */

import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { RealtimeEvent } from '@greenhouse/contract';
import { conversationInbox, getDb, messages, requests, runs } from '@greenhouse/db';
import type { Engine } from '../../engine/engine.js';
import { conflict, invalidInput } from '../../http/errors.js';
import type { Hub } from '../../realtime/hub.js';
import type { AgentsService } from '../agents/service.js';
import type { ConversationsService } from '../conversations/service.js';

/** The longest an outside client may write in one message. */
export const ASK_MAX_CHARS = 8_000;
/** Within the 60 s most MCP clients give a call. */
export const WAIT_MAX_SECONDS = 50;
/** One reply is cut beyond this; the app has the whole of it. */
const REPLY_MAX_CHARS = 20_000;
const REPLIES_MAX = 50;
/** How often a wait looks again when no event woke it. */
const POLL_MS = 1_000;

export type ExchangeStatus = 'answered' | 'working' | 'needs_you';

export interface Exchange {
  conversation_id: string;
  agent: { id: string; name: string } | null;
  /** `needs_you`: an approval or a question waits for the member in the app; nobody else can answer it. */
  status: ExchangeStatus;
  /** Replies and event lines after this point of the conversation. */
  after_seq: number;
  replies: Array<{
    seq: number;
    role: 'assistant' | 'event';
    agent_id: string | null;
    text: string;
    /** `streaming` while the reply is still being written. */
    status: string;
    created_at: string;
  }>;
  needs_you: Array<{ id: string; kind: string; title: string; created_at: string }>;
  /** The conversation in the Greenhouse app. */
  url: string;
}

export interface ExchangeDeps {
  agents: AgentsService;
  conversations: ConversationsService;
  engine: Engine;
  hub: Hub;
  /** The web app, for links. */
  issuer: string;
}

/** The conversation an event is about, when a wait should look again. Deltas are too frequent to count. */
function conversationOf(event: RealtimeEvent): string | null {
  switch (event.type) {
    case 'message.created':
    case 'message.updated':
      return event.data.message.conversation_id;
    case 'conversation.updated':
    case 'conversation.resync':
      return event.data.conversation_id;
    case 'run.updated':
    case 'request.updated':
      return event.data.conversation_id;
    default:
      return null;
  }
}

const cut = (text: string) =>
  text.length > REPLY_MAX_CHARS ? `${text.slice(0, REPLY_MAX_CHARS)}\n…(cut; read the rest in the app)` : text;

export function createExchange(deps: ExchangeDeps) {
  /** The member's Agent thread with the Agent's name as they see it, or not_an_agent_thread. */
  async function thread(memberId: string, conversationId: string) {
    const { conversation } = await deps.conversations.access(memberId, conversationId);
    if (conversation.kind !== 'main' && conversation.kind !== 'direct') {
      throw conflict('not_an_agent_thread', 'This is not the conversation with one of your Agents.');
    }
    if (!conversation.agentId) return { id: conversationId, agent: null };
    const people = await deps.conversations.people(memberId, conversationId);
    const name = people.agents.find((entry) => entry.id === conversation.agentId)?.name ?? '';
    return { id: conversationId, agent: { id: conversation.agentId, name } };
  }

  type Thread = Awaited<ReturnType<typeof thread>>;

  async function snapshot(memberId: string, at: Thread, afterSeq: number): Promise<Exchange> {
    const db = getDb();
    const [turns, queued, pending, rows] = await Promise.all([
      db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.conversationId, at.id), eq(runs.kind, 'turn'), inArray(runs.status, ['queued', 'running'])))
        .limit(1),
      db
        .select({ id: conversationInbox.id })
        .from(conversationInbox)
        .where(and(eq(conversationInbox.conversationId, at.id), isNull(conversationInbox.consumedAt)))
        .limit(1),
      db
        .select()
        .from(requests)
        .where(and(eq(requests.memberId, memberId), eq(requests.conversationId, at.id), eq(requests.status, 'pending')))
        .orderBy(asc(requests.id)),
      db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, at.id),
            gt(messages.seq, afterSeq),
            inArray(messages.role, ['assistant', 'event']),
          ),
        )
        .orderBy(asc(messages.seq))
        .limit(REPLIES_MAX),
    ]);
    return {
      conversation_id: at.id,
      agent: at.agent,
      status: pending.length ? 'needs_you' : turns.length || queued.length ? 'working' : 'answered',
      after_seq: afterSeq,
      replies: rows.map((row) => ({
        seq: row.seq,
        role: row.role === 'event' ? 'event' : 'assistant',
        agent_id: row.agentId,
        text: cut(row.content),
        status: row.status,
        created_at: row.createdAt,
      })),
      needs_you: pending.map((request) => ({
        id: request.id,
        kind: request.kind,
        title: typeof request.payload.title === 'string' ? request.payload.title : '',
        created_at: request.createdAt,
      })),
      url: `${deps.issuer}/#/c/${at.id}`,
    };
  }

  /**
   * Looks again whenever something happens in the conversation, until it stops working or time is
   * up. Replies handed to the caller count as read: the member has them, so nobody tells them again.
   */
  async function settle(memberId: string, at: Thread, afterSeq: number, waitMs: number) {
    const current = await wait(memberId, at, afterSeq, waitMs);
    const seen = current.replies.filter((reply) => reply.status !== 'streaming').at(-1)?.seq;
    if (seen) await deps.conversations.markRead(memberId, at.id, seen);
    return current;
  }

  async function wait(memberId: string, at: Thread, afterSeq: number, waitMs: number) {
    let current = await snapshot(memberId, at, afterSeq);
    if (current.status !== 'working' || waitMs <= 0) return current;
    const deadline = Date.now() + waitMs;
    let signaled = false;
    let wake: (() => void) | null = null;
    const unsubscribe = deps.hub.subscribe(memberId, (event) => {
      if (conversationOf(event) !== at.id) return;
      signaled = true;
      wake?.();
    });
    try {
      while (Date.now() < deadline) {
        if (!signaled) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(0, Math.min(POLL_MS, deadline - Date.now())));
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        signaled = false;
        wake = null;
        current = await snapshot(memberId, at, afterSeq);
        if (current.status !== 'working') break;
      }
    } finally {
      unsubscribe();
    }
    return current;
  }

  return {
    /**
     * Writes the message in the Agent's thread (`main` or an Agent id: one of the member's, or a
     * public Agent shared with them) and waits up to `waitSeconds` for the answer.
     */
    async ask(memberId: string, input: { agent: string; message: string; waitSeconds: number }): Promise<Exchange> {
      const content = input.message.trim();
      if (!content) throw invalidInput('Write a message.');
      if (content.length > ASK_MAX_CHARS) throw invalidInput(`Keep a message under ${ASK_MAX_CHARS} characters.`);
      const conversation = await deps.conversations.ensureDirect(memberId, input.agent);
      const sent = await deps.engine.post(memberId, conversation.id, { content, attachments: [], mentions: [] });
      return settle(memberId, await thread(memberId, conversation.id), sent.message.seq, input.waitSeconds * 1000);
    },

    /**
     * What happened in an Agent thread after `afterSeq`, by default after the member's latest
     * message there; waits up to `waitSeconds` while the Agent is still working.
     */
    async read(
      memberId: string,
      input: { conversationId: string; afterSeq?: number; waitSeconds: number },
    ): Promise<Exchange> {
      const at = await thread(memberId, input.conversationId);
      let afterSeq = input.afterSeq;
      if (afterSeq === undefined) {
        const [last] = await getDb()
          .select({ seq: messages.seq })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, input.conversationId),
              eq(messages.role, 'user'),
              eq(messages.authorMemberId, memberId),
            ),
          )
          .orderBy(desc(messages.seq))
          .limit(1);
        afterSeq = last?.seq ?? 0;
      }
      return settle(memberId, at, afterSeq, input.waitSeconds * 1000);
    },
  };
}

export type ExchangeService = ReturnType<typeof createExchange>;
