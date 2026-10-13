/**
 * Conversations and their messages. Who may see a conversation is decided only by
 * conversation_members. Messages get their sequence number under the conversation row lock,
 * so the transcript has one order. Turns (who answers and when) belong to the engine.
 */

import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type {
  Conversation,
  ConversationDetail,
  Message,
  Page,
  UpdateConversationInput,
  createConversationInputSchema,
} from '@greenhouse/contract';
import {
  agents,
  conversationAgents,
  conversationMembers,
  conversations,
  getDb,
  members,
  messages,
  newId,
  pins,
  requests,
  runs,
  transaction,
  type Conversation as ConversationRow,
  type ConversationMember,
  type Message as MessageRow,
  type NewMessage,
} from '@greenhouse/db';
import { agentGreeting } from '@greenhouse/types/agent-templates';
import { parseStoredDigest, renderDigest } from '../../engine/digest.js';
import type { z } from 'zod';
import { conflict, invalidInput, notFound } from '../../http/errors.js';
import type { ProvidersService } from '../../providers/service.js';
import type { AgentsService } from '../agents/service.js';

type CreateInput = z.output<typeof createConversationInputSchema>;

export interface Access {
  conversation: ConversationRow;
  membership: ConversationMember;
}

/** Fields the engine and services write; seq, conversation and time are filled in. */
export type AppendMessage = Omit<NewMessage, 'id' | 'conversationId' | 'seq' | 'createdAt'> & { id?: string };

export const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  conversation_id: row.conversationId,
  seq: row.seq,
  role: row.role,
  author_member_id: row.authorMemberId,
  agent_id: row.agentId,
  content: row.content,
  blocks: row.blocks,
  attachments: row.attachments,
  quote: row.quote ? { message_id: row.quote.messageId, text: row.quote.text } : null,
  mentions: row.mentions,
  citations: row.citations,
  steps: row.steps.map((step) => ({
    tool: step.tool,
    summary: step.summary,
    status: step.status,
    ...(step.durationMs !== undefined ? { duration_ms: step.durationMs } : {}),
  })),
  reasoning: row.reasoning,
  event: row.event,
  run_id: row.runId,
  status: row.status,
  edited_at: row.editedAt,
  created_at: row.createdAt,
});

const ACTIVE_TURN = ['queued', 'running'] as const;

/** Activity cursors carry the time and the id, so ties never skip or repeat a conversation. */
function encodeActivity(row: { lastActivityAt: string; id: string }) {
  return Buffer.from(JSON.stringify({ at: row.lastActivityAt, id: row.id })).toString('base64url');
}
function decodeActivity(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof value.at === 'string' && typeof value.id === 'string') return { at: value.at, id: value.id };
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid.');
}
function encodeSeq(seq: number) {
  return Buffer.from(JSON.stringify({ seq })).toString('base64url');
}
function decodeSeq(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { seq?: unknown };
    if (typeof value.seq === 'number' && Number.isInteger(value.seq)) return value.seq;
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid.');
}

export function createConversationsService(deps: { agents: AgentsService; providers: ProvidersService }) {
  async function localeOf(memberId: string): Promise<'zh' | 'en'> {
    const [member] = await getDb().select({ locale: members.locale }).from(members).where(eq(members.id, memberId));
    return member?.locale === 'en' ? 'en' : 'zh';
  }

  /** Reader state, pins, running turns and pending requests for a set of conversations. */
  async function views(memberId: string, rows: ConversationRow[]): Promise<Conversation[]> {
    if (!rows.length) return [];
    const db = getDb();
    const ids = rows.map((row) => row.id);
    const [memberships, pinned, working, pending, unread] = await Promise.all([
      db
        .select()
        .from(conversationMembers)
        .where(and(eq(conversationMembers.memberId, memberId), inArray(conversationMembers.conversationId, ids))),
      db
        .select({ id: pins.targetId })
        .from(pins)
        .where(and(eq(pins.memberId, memberId), eq(pins.targetType, 'conversation'), inArray(pins.targetId, ids))),
      db
        .select({ id: runs.conversationId })
        .from(runs)
        .where(and(inArray(runs.conversationId, ids), eq(runs.kind, 'turn'), inArray(runs.status, [...ACTIVE_TURN]))),
      db
        .select({ id: requests.conversationId, n: sql<number>`count(*)::int` })
        .from(requests)
        .where(
          and(inArray(requests.conversationId, ids), eq(requests.memberId, memberId), eq(requests.status, 'pending')),
        )
        .groupBy(requests.conversationId),
      db
        .select({ id: messages.conversationId, n: sql<number>`least(count(*), 99)::int` })
        .from(messages)
        .innerJoin(
          conversationMembers,
          and(
            eq(conversationMembers.conversationId, messages.conversationId),
            eq(conversationMembers.memberId, memberId),
          ),
        )
        .where(
          and(
            inArray(messages.conversationId, ids),
            eq(messages.role, 'assistant'),
            gt(messages.seq, conversationMembers.lastReadSeq),
          ),
        )
        .groupBy(messages.conversationId),
    ]);
    const membership = new Map(memberships.map((row) => [row.conversationId, row]));
    const pinnedIds = new Set(pinned.map((row) => row.id));
    const workingIds = new Set(working.map((row) => row.id));
    const pendingBy = new Map(pending.map((row) => [row.id, row.n]));
    const unreadBy = new Map(unread.map((row) => [row.id, row.n]));
    return rows.map((row) => {
      const mine = membership.get(row.id);
      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        agent_id: row.agentId,
        model: row.model,
        origin: row.origin,
        read_only: row.readOnly,
        last_seq: row.lastSeq,
        last_read_seq: mine?.lastReadSeq ?? 0,
        unread: unreadBy.get(row.id) ?? 0,
        pinned: pinnedIds.has(row.id),
        archived: !!mine?.archivedAt,
        muted: !!mine?.mutedAt,
        working: workingIds.has(row.id),
        pending_requests: pendingBy.get(row.id) ?? 0,
        last_activity_at: row.lastActivityAt,
        created_at: row.createdAt,
      };
    });
  }

  /** "What it remembers lately": the rolling summary as text, in the reader's language. */
  async function renderedDigest(memberId: string, row: ConversationRow): Promise<string> {
    const doc = parseStoredDigest(row.digest);
    if (!doc) return '';
    const owners = [...new Set(doc.open_items.map((item) => item.owner_agent_id).filter((id): id is string => !!id))];
    const names = owners.length
      ? await getDb().select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, owners))
      : [];
    return renderDigest(doc, await localeOf(memberId), new Map(names.map((entry) => [entry.id, entry.name])));
  }

  async function detail(memberId: string, row: ConversationRow): Promise<ConversationDetail> {
    const db = getDb();
    const [view] = await views(memberId, [row]);
    const people = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, row.id))
      .orderBy(asc(conversationMembers.createdAt));
    const present = await db
      .select({ id: conversationAgents.agentId })
      .from(conversationAgents)
      .where(eq(conversationAgents.conversationId, row.id));
    return {
      ...view!,
      members: people.map((person) => ({
        member_id: person.memberId,
        role: person.role,
        last_read_seq: person.lastReadSeq,
      })),
      agent_ids: present.map((agent) => agent.id),
      digest: await renderedDigest(memberId, row),
    };
  }

  /** Opens a conversation for a member, with the Agent's greeting as its first message. */
  async function open(
    memberId: string,
    values: Omit<typeof conversations.$inferInsert, 'id' | 'ownerId'>,
    greetingAgentId: string | null,
  ): Promise<ConversationRow | null> {
    return transaction(async (db) => {
      const [row] = await db
        .insert(conversations)
        .values({ id: newId('conversation'), ownerId: memberId, ...values })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      await db.insert(conversationMembers).values({ conversationId: row.id, memberId, role: 'owner' });
      if (greetingAgentId) {
        const [agent] = await db.select().from(agents).where(eq(agents.id, greetingAgentId));
        if (agent) {
          await service.append(row.id, {
            role: 'assistant',
            agentId: agent.id,
            content: agentGreeting(
              { name: agent.name, role: agent.role, templateKey: agent.templateKey },
              await localeOf(memberId),
              { computer: false, owned: agent.ownerId === memberId },
            ),
            event: { type: 'greeting' },
          });
        }
      }
      const [fresh] = await db.select().from(conversations).where(eq(conversations.id, row.id));
      return fresh!;
    });
  }

  const service = {
    /** The main thread: every member has exactly one, with the main Agent. Safe to call concurrently. */
    async ensureMain(memberId: string): Promise<ConversationRow> {
      const find = async () =>
        (
          await getDb()
            .select()
            .from(conversations)
            .where(and(eq(conversations.ownerId, memberId), eq(conversations.kind, 'main')))
        )[0];
      const existing = await find();
      if (existing) return existing;
      const main = await deps.agents.ensureMain(memberId);
      return (await open(memberId, { kind: 'main', agentId: main.id }, main.id)) ?? (await find())!;
    },

    /** The one Agent thread with an Agent of the member's. */
    async ensureDirect(memberId: string, agentIdOrHandle: string): Promise<ConversationRow> {
      const loaded = await deps.agents.load(memberId, agentIdOrHandle);
      if (loaded.agent.isMain) return service.ensureMain(memberId);
      if (loaded.agent.archivedAt) throw conflict('agent_archived', 'This Agent is archived.');
      const find = async () =>
        (
          await getDb()
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.ownerId, memberId),
                eq(conversations.kind, 'direct'),
                eq(conversations.agentId, loaded.agent.id),
              ),
            )
        )[0];
      const existing = await find();
      if (existing) return existing;
      return (await open(memberId, { kind: 'direct', agentId: loaded.agent.id }, loaded.agent.id)) ?? (await find())!;
    },

    /** Throws not_found unless the member is in the conversation. */
    async access(memberId: string, conversationId: string): Promise<Access> {
      const [row] = await getDb()
        .select({ conversation: conversations, membership: conversationMembers })
        .from(conversations)
        .innerJoin(
          conversationMembers,
          and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.memberId, memberId)),
        )
        .where(eq(conversations.id, conversationId));
      if (!row) throw notFound('Conversation');
      return row;
    },

    async list(
      memberId: string,
      query: { kind?: Conversation['kind']; q?: string; archived: 'true' | 'false'; cursor?: string; limit: number },
    ): Promise<Page<Conversation>> {
      await service.ensureMain(memberId);
      const db = getDb();
      const after = decodeActivity(query.cursor);
      const pinnedIds = (
        await db
          .select({ id: pins.targetId })
          .from(pins)
          .where(and(eq(pins.memberId, memberId), eq(pins.targetType, 'conversation')))
      ).map((row) => row.id);
      const filters = and(
        query.kind ? eq(conversations.kind, query.kind) : undefined,
        query.q ? ilike(conversations.title, `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
        query.archived === 'true' ? isNotNull(conversationMembers.archivedAt) : isNull(conversationMembers.archivedAt),
      );
      const base = () =>
        db
          .select({ conversation: conversations })
          .from(conversations)
          .innerJoin(
            conversationMembers,
            and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.memberId, memberId)),
          );
      // Pinned conversations lead the first page; later pages leave them out.
      const pinnedRows =
        !after && pinnedIds.length
          ? await base()
              .where(and(filters, inArray(conversations.id, pinnedIds)))
              .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
          : [];
      const rows = await base()
        .where(
          and(
            filters,
            pinnedIds.length ? notInArray(conversations.id, pinnedIds) : undefined,
            after
              ? or(
                  lt(conversations.lastActivityAt, after.at),
                  and(eq(conversations.lastActivityAt, after.at), lt(conversations.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const page = (more ? rows.slice(0, query.limit) : rows).map((row) => row.conversation);
      return {
        items: await views(memberId, [...pinnedRows.map((row) => row.conversation), ...page]),
        next_cursor: more ? encodeActivity(page[page.length - 1]!) : null,
      };
    },

    async get(memberId: string, conversationId: string): Promise<ConversationDetail> {
      const { conversation } = await service.access(memberId, conversationId);
      return detail(memberId, conversation);
    },

    async create(memberId: string, input: CreateInput): Promise<ConversationDetail> {
      if (input.kind === 'direct') return detail(memberId, await service.ensureDirect(memberId, input.agent_id));
      if (input.kind === 'chat') {
        const loaded = await deps.agents.load(memberId, input.agent_id ?? 'main');
        if (loaded.agent.archivedAt) throw conflict('agent_archived', 'This Agent is archived.');
        if (input.model && !(await deps.providers.modelAvailable(input.model, { memberId }))) {
          throw invalidInput(`The model "${input.model}" is not available.`);
        }
        const row = await open(
          memberId,
          {
            kind: 'chat',
            agentId: loaded.agent.id,
            title: input.title ?? '',
            model: input.model ?? null,
            context: input.context ?? null,
          },
          null,
        );
        return detail(memberId, row!);
      }
      // A room: people, and Agents the creator brings.
      const others = [...new Set(input.member_ids)].filter((id) => id !== memberId);
      if (others.length) {
        const active = await getDb()
          .select({ id: members.id })
          .from(members)
          .where(and(inArray(members.id, others), eq(members.status, 'active')));
        if (active.length !== others.length) throw invalidInput('Some people cannot be added.');
      }
      const agentIds: string[] = [];
      for (const handle of [...new Set(input.agent_ids)]) {
        const loaded = await deps.agents.load(memberId, handle);
        if (loaded.agent.archivedAt) throw conflict('agent_archived', `${loaded.agent.name} is archived.`);
        agentIds.push(loaded.agent.id);
      }
      const row = await transaction(async (db) => {
        const created = (await open(memberId, { kind: 'room', title: input.title ?? '' }, null))!;
        if (others.length) {
          await db.insert(conversationMembers).values(
            others.map((id) => ({
              conversationId: created.id,
              memberId: id,
              role: 'member' as const,
              addedBy: memberId,
            })),
          );
        }
        if (agentIds.length) {
          await db
            .insert(conversationAgents)
            .values(agentIds.map((id) => ({ conversationId: created.id, agentId: id, addedBy: memberId })));
        }
        return created;
      });
      return detail(memberId, row);
    },

    async update(
      memberId: string,
      conversationId: string,
      input: UpdateConversationInput,
    ): Promise<ConversationDetail> {
      const { conversation, membership } = await service.access(memberId, conversationId);
      const db = getDb();
      await transaction(async () => {
        if (input.title !== undefined || input.model !== undefined) {
          if (input.model && conversation.kind !== 'chat') throw invalidInput('Only a chat has its own model.');
          if (input.model && !(await deps.providers.modelAvailable(input.model, { memberId }))) {
            throw invalidInput(`The model "${input.model}" is not available.`);
          }
          await db
            .update(conversations)
            .set({
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              updatedAt: sql`now()`,
            })
            .where(eq(conversations.id, conversationId));
        }
        if (input.archived !== undefined || input.muted !== undefined) {
          await db
            .update(conversationMembers)
            .set({
              ...(input.archived !== undefined
                ? { archivedAt: input.archived ? (membership.archivedAt ?? sql`now()`) : null }
                : {}),
              ...(input.muted !== undefined
                ? { mutedAt: input.muted ? (membership.mutedAt ?? sql`now()`) : null }
                : {}),
            })
            .where(
              and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberId, memberId)),
            );
        }
        if (input.pinned === true) {
          await db
            .insert(pins)
            .values({ memberId, targetType: 'conversation', targetId: conversationId })
            .onConflictDoNothing();
        } else if (input.pinned === false) {
          await db
            .delete(pins)
            .where(
              and(eq(pins.memberId, memberId), eq(pins.targetType, 'conversation'), eq(pins.targetId, conversationId)),
            );
        }
      });
      return service.get(memberId, conversationId);
    },

    /** Chats and rooms can be deleted by their owner; the main and Agent threads are kept. */
    async remove(memberId: string, conversationId: string): Promise<void> {
      const { conversation } = await service.access(memberId, conversationId);
      if (conversation.kind === 'main' || conversation.kind === 'direct') {
        throw conflict('conversation_protected', 'This conversation cannot be deleted; archive it instead.');
      }
      if (conversation.ownerId !== memberId)
        throw conflict('not_owner', 'Only the person who started it can delete it.');
      await transaction(async (db) => {
        await db.delete(pins).where(and(eq(pins.targetType, 'conversation'), eq(pins.targetId, conversationId)));
        await db.delete(conversations).where(eq(conversations.id, conversationId));
      });
    },

    async messages(
      memberId: string,
      conversationId: string,
      query: { cursor?: string; after?: number; limit: number },
    ): Promise<Page<Message>> {
      await service.access(memberId, conversationId);
      const db = getDb();
      if (query.after !== undefined) {
        const rows = await db
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, query.after)))
          .orderBy(asc(messages.seq))
          .limit(query.limit + 1);
        const more = rows.length > query.limit;
        const items = more ? rows.slice(0, query.limit) : rows;
        return { items: items.map(toMessage), next_cursor: more ? encodeSeq(items[items.length - 1]!.seq) : null };
      }
      const before = decodeSeq(query.cursor);
      const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), before !== null ? lt(messages.seq, before) : undefined))
        .orderBy(desc(messages.seq))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const items = (more ? rows.slice(0, query.limit) : rows).reverse();
      // The page reads oldest to newest; the cursor points at older messages.
      return { items: items.map(toMessage), next_cursor: more ? encodeSeq(items[0]!.seq) : null };
    },

    async markRead(memberId: string, conversationId: string, seq: number): Promise<void> {
      const { conversation } = await service.access(memberId, conversationId);
      await getDb()
        .update(conversationMembers)
        .set({ lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${Math.min(seq, conversation.lastSeq)})` })
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberId, memberId)));
    },

    /** Appends a message under the conversation lock: the only way a sequence number is given out. */
    async append(conversationId: string, message: AppendMessage): Promise<MessageRow> {
      return transaction(async (db) => {
        const [locked] = await db
          .select({ lastSeq: conversations.lastSeq })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .for('update');
        if (!locked) throw notFound('Conversation');
        const seq = locked.lastSeq + 1;
        const [row] = await db
          .insert(messages)
          .values({ id: message.id ?? newId('message'), ...message, conversationId, seq })
          .returning();
        await db
          .update(conversations)
          .set({ lastSeq: seq, lastActivityAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(conversations.id, conversationId));
        return row!;
      });
    },

    /** Agents that may speak in a conversation: its own and the ones present. */
    async presentAgentIds(conversation: ConversationRow): Promise<string[]> {
      const rows = await getDb()
        .select({ id: conversationAgents.agentId })
        .from(conversationAgents)
        .where(eq(conversationAgents.conversationId, conversation.id));
      return [...new Set([...(conversation.agentId ? [conversation.agentId] : []), ...rows.map((row) => row.id)])];
    },
  };
  return service;
}

export type ConversationsService = ReturnType<typeof createConversationsService>;
