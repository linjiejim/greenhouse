import { recordAt as sourceRecordAt } from '../tables/load.js';
import { loadReader as sourceReader } from '../tables/access.js';
/**
 * Conversations and their messages. Who may see a conversation is decided only by
 * conversation_members. Messages get their sequence number under the conversation row lock,
 * so the transcript has one order. Turns (who answers and when) belong to the engine.
 */

import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type {
  AgentAvatar,
  Conversation,
  ConversationDetail,
  ConversationMembers,
  Feedback,
  Message,
  MessageItem,
  Note,
  Page,
  RealtimeEvent,
  UpdateConversationInput,
  UpdateNoteInput,
  addMembersInputSchema,
  createConversationInputSchema,
  createNoteInputSchema,
  feedbackInputSchema,
} from '@greenhouse/contract';
import {
  agents,
  conversationAgents,
  conversationMembers,
  conversationNotes,
  conversations,
  files,
  getDb,
  members,
  messageFeedback,
  messages,
  newId,
  pins,
  requests,
  runs,
  transaction,
  type Agent as AgentRow,
  type Conversation as ConversationRow,
  type ConversationMember,
  type ConversationNote,
  type Message as MessageRow,
  type NewMessage,
} from '@greenhouse/db';
import { agentGreeting } from '@greenhouse/types/agent-templates';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { audit } from '../../audit.js';
import { parseStoredDigest, renderDigest } from '../../engine/digest.js';
import type { z } from 'zod';
import { conflict, invalidInput, notFound } from '../../http/errors.js';
import { containing } from '../../http/like.js';
import type { ProvidersService } from '../../providers/service.js';
import type { Hub } from '../../realtime/hub.js';
import { agentIdOf, type AgentsService } from '../agents/service.js';
import type { FilesService } from '../files/service.js';
import { readableDocs } from '../knowledge/access.js';
import { summaryFor } from '../members/service.js';
import type { NotificationsService } from '../notifications/service.js';
import { exportFilename, renderConversationMarkdown, type ExportedMessage } from './export.js';

type CreateInput = z.output<typeof createConversationInputSchema>;
type AddMembersInput = z.output<typeof addMembersInputSchema>;
type CreateNoteInput = z.output<typeof createNoteInputSchema>;
type FeedbackInput = z.output<typeof feedbackInputSchema>;

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
  skill: row.skill
    ? { skill_id: row.skill.skillId, version: row.skill.version ?? null, variables: row.skill.variables ?? {} }
    : null,
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

type Citation = Message['citations'][number];
/** The docs and table records a message names as sources. */
const citedSources = (citations: readonly Citation[]) =>
  citations.filter((citation) => citation.kind === 'doc' || citation.kind === 'record');

/**
 * Sources as one person may see them: a doc they cannot read now is left out, so a reply in a
 * room never shows the others the title of what only the asker may read.
 */
async function sourcesFor(memberId: string, sources: readonly Citation[], agentId: string | null = null) {
  const readable = await readableDocs(
    memberId,
    sources.filter((s) => s.kind === 'doc').map((s) => s.id),
    agentId,
  );
  const records = new Set<string>();
  if (sources.some((s) => s.kind === 'record')) {
    const reader = await sourceReader(memberId).catch(() => null);
    if (reader)
      for (const id of new Set(sources.filter((s) => s.kind === 'record').map((s) => s.id))) {
        if (
          await sourceRecordAt(reader, id, 'viewer').then(
            () => true,
            () => false,
          )
        )
          records.add(id);
      }
  }
  return (citations: Citation[]) =>
    citations.filter((s) => (s.kind === 'doc' ? readable.has(s.id) : s.kind === 'record' ? records.has(s.id) : true));
}

const toNote = (row: ConversationNote): Note => ({
  id: row.id,
  conversation_id: row.conversationId,
  title: row.title,
  body: row.body,
  status: row.status,
  pinned: row.pinned,
  author_member_id: row.authorMemberId,
  author_agent_id: row.authorAgentId,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

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
/** Notes are listed pinned first, then newest first; the cursor carries both. */
function encodeNoteCursor(row: { pinned: boolean; id: string }) {
  return Buffer.from(JSON.stringify({ pinned: row.pinned, id: row.id })).toString('base64url');
}
function decodeNoteCursor(cursor: string | undefined): { pinned: boolean; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { pinned?: unknown; id?: unknown };
    if (typeof value.pinned === 'boolean' && typeof value.id === 'string')
      return { pinned: value.pinned, id: value.id };
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

/** Who joined first; people added together (a room's start) list its owner first. */
const SEAT_ORDER = [
  asc(conversationMembers.createdAt),
  sql`(${conversationMembers.role} = 'owner') desc`,
  asc(conversationMembers.memberId),
] as const;

export function createConversationsService(deps: {
  agents: AgentsService;
  providers: ProvidersService;
  hub: Hub;
  files: FilesService;
  notifications: Pick<NotificationsService, 'markConversationRead'>;
}) {
  async function localeOf(memberId: string): Promise<'zh' | 'en'> {
    const [member] = await getDb().select({ locale: members.locale }).from(members).where(eq(members.id, memberId));
    return member?.locale === 'en' ? 'en' : 'zh';
  }

  /** Writes that change what everyone in the conversation shares. */
  function assertWritable(conversation: ConversationRow) {
    if (conversation.readOnly) throw conflict('read_only', 'This conversation is read only.');
  }

  /** The people and Agents of a conversation, as the info panel shows them to one reader. */
  async function peopleOf(conversation: ConversationRow, readerId: string): Promise<ConversationMembers> {
    const db = getDb();
    const seats = await db
      .select({ seat: conversationMembers, member: members })
      .from(conversationMembers)
      .innerJoin(members, eq(members.id, conversationMembers.memberId))
      .where(eq(conversationMembers.conversationId, conversation.id))
      .orderBy(...SEAT_ORDER);
    const agentIds = await service.presentAgentIds(conversation);
    const rows = agentIds.length
      ? await db
          .select({
            id: agents.id,
            name: agents.name,
            role: agents.role,
            avatar: agents.avatar,
            ownerId: agents.ownerId,
          })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Someone else's public Agent shows its audience the published face.
    const faces = await deps.agents.publishedFaces(
      readerId,
      rows.filter((row) => row.ownerId !== readerId).map((row) => row.id),
    );
    const summary = summaryFor(deps.files, readerId);
    return {
      members: seats.map(({ seat, member }) => ({
        ...summary(member),
        role: seat.role,
        last_read_seq: seat.lastReadSeq,
        joined_at: seat.createdAt,
      })),
      agents: agentIds.flatMap((id) => {
        const agent = byId.get(id);
        if (!agent) return [];
        const face = faces.get(id) ?? { name: agent.name, role: agent.role, avatar: agent.avatar as AgentAvatar };
        return [{ id, ...face, owner_id: agent.ownerId }];
      }),
    };
  }

  /** A room, for changing who is in it. */
  async function room(memberId: string, conversationId: string): Promise<ConversationRow> {
    const { conversation } = await service.access(memberId, conversationId);
    if (conversation.kind !== 'room') throw conflict('not_a_room', 'Only a room has people and Agents to change.');
    return conversation;
  }

  async function noteOf(conversationId: string, noteId: string): Promise<ConversationNote> {
    const [row] = await getDb()
      .select()
      .from(conversationNotes)
      .where(and(eq(conversationNotes.id, noteId), eq(conversationNotes.conversationId, conversationId)));
    if (!row) throw notFound('Note');
    return row;
  }

  const notesChanged = (conversationId: string, noteId: string) =>
    service.publish(conversationId, {
      type: 'notes.updated',
      data: { conversation_id: conversationId, note_id: noteId },
    });

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
      .orderBy(...SEAT_ORDER);
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

  /** Opens a conversation for a member, with the Agent's greeting (as the member sees it) first. */
  async function open(
    memberId: string,
    values: Omit<typeof conversations.$inferInsert, 'id' | 'ownerId'>,
    greeting: Pick<AgentRow, 'id' | 'name' | 'role' | 'templateKey' | 'ownerId'> | null,
  ): Promise<ConversationRow | null> {
    return transaction(async (db) => {
      const [row] = await db
        .insert(conversations)
        .values({ id: newId('conversation'), ownerId: memberId, ...values })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      await db.insert(conversationMembers).values({ conversationId: row.id, memberId, role: 'owner' });
      if (greeting) {
        await service.append(row.id, {
          role: 'assistant',
          agentId: greeting.id,
          content: agentGreeting(
            { name: greeting.name, role: greeting.role, templateKey: greeting.templateKey },
            await localeOf(memberId),
            { computer: false, owned: greeting.ownerId === memberId },
          ),
          event: { type: 'greeting' },
        });
      }
      const [fresh] = await db.select().from(conversations).where(eq(conversations.id, row.id));
      return fresh!;
    });
  }

  /**
   * Every event for a conversation's people leaves here. A message that cites docs reaches each
   * person with only the sources they may open.
   */
  async function deliver(audience: readonly string[], event: RealtimeEvent): Promise<void> {
    const message = event.type === 'message.created' || event.type === 'message.updated' ? event.data.message : null;
    const sources = message ? citedSources(message.citations) : [];
    if (!message || !sources.length) {
      deps.hub.publish(audience, event);
      return;
    }
    const seeing = new Map<string, { citations: Citation[]; members: string[] }>();
    for (const memberId of audience) {
      const citations = (await sourcesFor(memberId, sources, message.agent_id))(message.citations);
      const key = citations.map((citation) => `${citation.kind}:${citation.id}`).join('\n');
      const same = seeing.get(key) ?? { citations, members: [] };
      same.members.push(memberId);
      seeing.set(key, same);
    }
    for (const { citations, members: people } of seeing.values()) {
      deps.hub.publish(people, {
        type: event.type,
        data: { message: { ...message, citations } },
      } as RealtimeEvent);
    }
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
      return (await open(memberId, { kind: 'main', agentId: main.id }, main)) ?? (await find())!;
    },

    /**
     * The one Agent thread with an Agent: one of the member's, or someone else's public Agent shared
     * with them. A thread that exists stays theirs to read whatever became of the Agent; the engine
     * refuses new turns it may no longer take.
     */
    async ensureDirect(memberId: string, agentIdOrHandle: string): Promise<ConversationRow> {
      const own = await deps.agents.findOwn(memberId, agentIdOrHandle);
      if (own?.isMain) return service.ensureMain(memberId);
      if (own?.archivedAt) throw conflict('agent_archived', 'This Agent is archived.');
      const agentId = own?.id ?? agentIdOf(agentIdOrHandle);
      const find = async () =>
        (
          await getDb()
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.ownerId, memberId),
                eq(conversations.kind, 'direct'),
                eq(conversations.agentId, agentId),
              ),
            )
        )[0];
      const existing = await find();
      if (existing) return existing;
      const agent = own ?? (await deps.agents.openPublic(memberId, agentId))?.agent;
      if (!agent) throw notFound('Agent');
      return (await open(memberId, { kind: 'direct', agentId }, agent)) ?? (await find())!;
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
        query.q ? ilike(conversations.title, containing(query.q)) : undefined,
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
    ): Promise<Page<MessageItem>> {
      await service.access(memberId, conversationId);
      const db = getDb();
      /** Each message with the reader's own rating, and only the sources they may open. */
      const withRatings = async (rows: MessageRow[]): Promise<MessageItem[]> => {
        const replies = rows.filter((row) => row.role === 'assistant').map((row) => row.id);
        const [rated, visible] = await Promise.all([
          replies.length
            ? db
                .select({ id: messageFeedback.messageId, rating: messageFeedback.rating })
                .from(messageFeedback)
                .where(and(eq(messageFeedback.memberId, memberId), inArray(messageFeedback.messageId, replies)))
            : [],
          Promise.all(rows.map((row) => sourcesFor(memberId, citedSources(row.citations), row.agentId))),
        ]);
        const ratings = new Map(rated.map((row) => [row.id, row.rating]));
        return rows.map((row, index) => {
          const rating = ratings.get(row.id);
          return {
            ...toMessage(row),
            citations: visible[index]!(row.citations),
            my_rating: rating === 1 || rating === -1 ? rating : null,
          };
        });
      };
      if (query.after !== undefined) {
        const rows = await db
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, query.after)))
          .orderBy(asc(messages.seq))
          .limit(query.limit + 1);
        const more = rows.length > query.limit;
        const items = more ? rows.slice(0, query.limit) : rows;
        return {
          items: await withRatings(items),
          next_cursor: more ? encodeSeq(items[items.length - 1]!.seq) : null,
        };
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
      return { items: await withRatings(items), next_cursor: more ? encodeSeq(items[0]!.seq) : null };
    },

    /**
     * 👍 / 👎 on a reply from an Agent, one per person; 0 takes it back. It keeps which Agent and
     * which version wrote the reply: the version its turn ran on, else the Agent's current one.
     */
    async rate(memberId: string, conversationId: string, messageId: string, input: FeedbackInput): Promise<Feedback> {
      await service.access(memberId, conversationId);
      const db = getDb();
      const [message] = await db
        .select({ id: messages.id, role: messages.role, agentId: messages.agentId, runId: messages.runId })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)));
      if (!message) throw notFound('Message');
      if (message.role !== 'assistant' || !message.agentId) {
        throw conflict('not_a_reply', 'Only replies from an Agent can be rated.');
      }
      if (input.rating === 0) {
        await db
          .delete(messageFeedback)
          .where(and(eq(messageFeedback.messageId, messageId), eq(messageFeedback.memberId, memberId)));
        return { rating: 0, comment: '' };
      }
      let version: number | null = null;
      if (message.runId) {
        const [run] = await db.select({ input: runs.input }).from(runs).where(eq(runs.id, message.runId));
        const recorded = run?.input.agent_version;
        if (typeof recorded === 'number') version = recorded;
      }
      if (version === null) {
        const [agent] = await db
          .select({ version: agents.currentVersion })
          .from(agents)
          .where(eq(agents.id, message.agentId));
        version = agent?.version ?? null;
      }
      const values = {
        rating: input.rating,
        comment: input.comment ?? '',
        agentId: message.agentId,
        agentVersion: version,
      };
      const [saved] = await db
        .insert(messageFeedback)
        .values({ messageId, memberId, ...values })
        .onConflictDoUpdate({ target: [messageFeedback.messageId, messageFeedback.memberId], set: values })
        .returning();
      return { rating: saved!.rating === 1 ? 1 : -1, comment: saved!.comment };
    },

    /** Everyone who sees a conversation: its people. */
    async audience(conversationId: string): Promise<string[]> {
      const rows = await getDb()
        .select({ id: conversationMembers.memberId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId));
      return rows.map((row) => row.id);
    },

    /**
     * Tells everyone in the conversation (and anyone named in `also`, like a person who just
     * left). A message that cites docs reaches each person with only the sources they may open.
     */
    async publish(conversationId: string, event: RealtimeEvent, also: string[] = []): Promise<void> {
      await deliver([...new Set([...(await service.audience(conversationId)), ...also])], event);
    },

    /**
     * A publisher for one conversation that looks its people up once and keeps them until they
     * change (an empty `conversation.updated`, from any process): a turn sends a frame every
     * 75 ms and must not query the members for each. Events leave in the order given, filtered
     * like `publish`. Close it when done.
     */
    audienceOf(conversationId: string) {
      let people: Promise<string[]> | null = null;
      let order: Promise<void> = Promise.resolve();
      const stop = deps.hub.observe((event) => {
        if (
          event.type === 'conversation.updated' &&
          event.data.conversation_id === conversationId &&
          !Object.keys(event.data.changes).length
        ) {
          people = null;
        }
      });
      return {
        publish(event: RealtimeEvent): Promise<void> {
          order = order
            .then(async () => deliver(await (people ??= service.audience(conversationId)), event))
            .catch((error: unknown) => {
              people = null;
              logger.warn('[conversations] could not publish an event', { error: toErrorMessage(error) });
            });
          return order;
        },
        close: stop,
      };
    },

    /** The people and Agents of a conversation. */
    async people(memberId: string, conversationId: string): Promise<ConversationMembers> {
      const { conversation } = await service.access(memberId, conversationId);
      return peopleOf(conversation, memberId);
    },

    /** Anyone in a room may bring people in; an Agent comes in only with its owner's say. */
    async addMembers(memberId: string, conversationId: string, input: AddMembersInput): Promise<ConversationMembers> {
      const conversation = await room(memberId, conversationId);
      assertWritable(conversation);
      const people = [...new Set(input.member_ids)];
      if (people.length) {
        const active = await getDb()
          .select({ id: members.id })
          .from(members)
          .where(and(inArray(members.id, people), eq(members.status, 'active')));
        if (active.length !== people.length) throw invalidInput('Some people cannot be added.');
      }
      const agentIds: string[] = [];
      for (const handle of [...new Set(input.agent_ids)]) {
        // Only the member's own Agents load; anyone else's is not found.
        const loaded = await deps.agents.load(memberId, handle);
        if (loaded.agent.archivedAt) throw conflict('agent_archived', `${loaded.agent.name} is archived.`);
        agentIds.push(loaded.agent.id);
      }
      await transaction(async (db) => {
        const joined = people.length
          ? await db
              .insert(conversationMembers)
              .values(
                people.map((id) => ({ conversationId, memberId: id, role: 'member' as const, addedBy: memberId })),
              )
              .onConflictDoNothing()
              .returning({ id: conversationMembers.memberId })
          : [];
        if (agentIds.length) {
          await db
            .insert(conversationAgents)
            .values(agentIds.map((id) => ({ conversationId, agentId: id, addedBy: memberId })))
            .onConflictDoNothing();
        }
        // Joining opens the whole history to them: an access grant, so it is audited.
        for (const { id } of joined) {
          await audit({
            actorId: memberId,
            action: 'conversation.member_add',
            resourceType: 'member',
            resourceId: id,
            scopeType: 'conversation',
            scopeId: conversationId,
          });
        }
        await db
          .update(conversations)
          .set({ updatedAt: sql`now()` })
          .where(eq(conversations.id, conversationId));
      });
      await service.publish(conversationId, {
        type: 'conversation.updated',
        data: { conversation_id: conversationId, changes: {} },
      });
      return peopleOf(conversation, memberId);
    },

    /**
     * The owner removes someone, or anyone leaves (removes themselves). Their Agents leave with
     * them; when the owner leaves, the person who joined first after them owns the room. A room
     * keeps at least one person. The engine then lets go of what was theirs here (engine.release).
     */
    async removeMember(memberId: string, conversationId: string, targetId: string): Promise<void> {
      await room(memberId, conversationId);
      await transaction(async (db) => {
        const [locked] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .for('update');
        if (!locked) throw notFound('Conversation');
        if (targetId !== memberId && locked.ownerId !== memberId) {
          throw conflict('not_owner', 'Only the person who started the room can remove people.');
        }
        const seats = await db
          .select()
          .from(conversationMembers)
          .where(eq(conversationMembers.conversationId, conversationId))
          .orderBy(...SEAT_ORDER);
        if (!seats.some((seat) => seat.memberId === targetId)) throw notFound('Member');
        if (seats.length <= 1) {
          throw conflict('last_member', 'A room keeps at least one person; delete it instead.');
        }
        await db
          .delete(conversationMembers)
          .where(
            and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberId, targetId)),
          );
        const theirs = db.select({ id: agents.id }).from(agents).where(eq(agents.ownerId, targetId));
        await db
          .delete(conversationAgents)
          .where(
            and(eq(conversationAgents.conversationId, conversationId), inArray(conversationAgents.agentId, theirs)),
          );
        await db
          .delete(pins)
          .where(
            and(eq(pins.memberId, targetId), eq(pins.targetType, 'conversation'), eq(pins.targetId, conversationId)),
          );
        if (locked.ownerId === targetId) {
          const next = seats.find((seat) => seat.memberId !== targetId)!;
          await db
            .update(conversationMembers)
            .set({ role: 'owner' })
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.memberId, next.memberId),
              ),
            );
          await db.update(conversations).set({ ownerId: next.memberId }).where(eq(conversations.id, conversationId));
        }
        await db
          .update(conversations)
          .set({ updatedAt: sql`now()` })
          .where(eq(conversations.id, conversationId));
        await audit({
          actorId: memberId,
          action: targetId === memberId ? 'conversation.leave' : 'conversation.member_remove',
          resourceType: 'member',
          resourceId: targetId,
          scopeType: 'conversation',
          scopeId: conversationId,
        });
      });
      // The person who left hears it too, so their apps drop the conversation.
      await service.publish(
        conversationId,
        { type: 'conversation.updated', data: { conversation_id: conversationId, changes: {} } },
        [targetId],
      );
    },

    /** Shared notes, pinned first, then newest first. */
    async notes(
      memberId: string,
      conversationId: string,
      query: { cursor?: string; limit: number },
    ): Promise<Page<Note>> {
      await service.access(memberId, conversationId);
      const after = decodeNoteCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(conversationNotes)
        .where(
          and(
            eq(conversationNotes.conversationId, conversationId),
            after
              ? or(
                  and(eq(conversationNotes.pinned, after.pinned), lt(conversationNotes.id, after.id)),
                  after.pinned ? eq(conversationNotes.pinned, false) : undefined,
                )
              : undefined,
          ),
        )
        .orderBy(desc(conversationNotes.pinned), desc(conversationNotes.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const items = more ? rows.slice(0, query.limit) : rows;
      return { items: items.map(toNote), next_cursor: more ? encodeNoteCursor(items[items.length - 1]!) : null };
    },

    async addNote(memberId: string, conversationId: string, input: CreateNoteInput): Promise<Note> {
      const { conversation } = await service.access(memberId, conversationId);
      assertWritable(conversation);
      const [row] = await getDb()
        .insert(conversationNotes)
        .values({
          id: newId('note'),
          conversationId,
          title: input.title,
          body: input.body,
          status: input.status,
          pinned: input.pinned,
          authorMemberId: memberId,
        })
        .returning();
      await notesChanged(conversationId, row!.id);
      return toNote(row!);
    },

    async updateNote(memberId: string, conversationId: string, noteId: string, input: UpdateNoteInput): Promise<Note> {
      const { conversation } = await service.access(memberId, conversationId);
      assertWritable(conversation);
      const current = await noteOf(conversationId, noteId);
      if (!(input.title ?? current.title) && !(input.body ?? current.body).trim()) {
        throw invalidInput('Write a title or some text.');
      }
      const [row] = await getDb()
        .update(conversationNotes)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(conversationNotes.id, noteId), eq(conversationNotes.conversationId, conversationId)))
        .returning();
      if (!row) throw notFound('Note');
      await notesChanged(conversationId, noteId);
      return toNote(row);
    },

    async removeNote(memberId: string, conversationId: string, noteId: string): Promise<void> {
      const { conversation } = await service.access(memberId, conversationId);
      assertWritable(conversation);
      const deleted = await getDb()
        .delete(conversationNotes)
        .where(and(eq(conversationNotes.id, noteId), eq(conversationNotes.conversationId, conversationId)))
        .returning({ id: conversationNotes.id });
      if (!deleted.length) throw notFound('Note');
      await notesChanged(conversationId, noteId);
    },

    /** The whole conversation as Markdown, in the reader's language and time zone. */
    async exportMarkdown(memberId: string, conversationId: string): Promise<{ filename: string; markdown: string }> {
      const { conversation } = await service.access(memberId, conversationId);
      const db = getDb();
      const [reader] = await db
        .select({ locale: members.locale, timezone: members.timezone })
        .from(members)
        .where(eq(members.id, memberId));
      const locale = reader?.locale === 'en' ? 'en' : 'zh';
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.seq));
      const memberIds = [...new Set(rows.map((row) => row.authorMemberId).filter((id): id is string => !!id))];
      const agentIds = [
        ...new Set([conversation.agentId, ...rows.map((row) => row.agentId)].filter((id): id is string => !!id)),
      ];
      const fileIds = [...new Set(rows.flatMap((row) => row.attachments))];
      const [people, speakers, attached] = await Promise.all([
        memberIds.length
          ? db.select({ id: members.id, name: members.name }).from(members).where(inArray(members.id, memberIds))
          : [],
        agentIds.length
          ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
          : [],
        fileIds.length
          ? db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, fileIds))
          : [],
      ]);
      const personName = new Map(people.map((row) => [row.id, row.name]));
      const agentName = new Map(speakers.map((row) => [row.id, row.name]));
      const fileName = new Map(attached.map((row) => [row.id, row.name]));
      const unknown =
        locale === 'zh'
          ? { member: '成员', agent: 'Agent', file: '文件' }
          : { member: 'Member', agent: 'Agent', file: 'file' };
      const title =
        conversation.title ||
        (conversation.agentId ? agentName.get(conversation.agentId) : undefined) ||
        (locale === 'zh' ? '对话' : 'Conversation');
      const exported: ExportedMessage[] = rows.map((row) => ({
        role: row.role,
        author:
          row.role === 'user'
            ? (personName.get(row.authorMemberId ?? '') ?? unknown.member)
            : (agentName.get(row.agentId ?? '') ?? unknown.agent),
        createdAt: row.createdAt,
        content: row.content,
        quote: row.quote?.text ?? null,
        steps: row.steps.map((step) => ({ summary: step.summary, failed: step.status === 'failed' })),
        attachments: row.attachments.map((id) => fileName.get(id) ?? unknown.file),
        status: row.status,
      }));
      return {
        filename: exportFilename(title, locale === 'zh' ? '对话' : 'conversation'),
        markdown: renderConversationMarkdown({
          title,
          locale,
          timeZone: reader?.timezone || 'UTC',
          exportedAt: new Date().toISOString(),
          messages: exported,
        }),
      };
    },

    async markRead(memberId: string, conversationId: string, seq: number): Promise<void> {
      const { conversation } = await service.access(memberId, conversationId);
      const [seat] = await getDb()
        .update(conversationMembers)
        .set({ lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${Math.min(seq, conversation.lastSeq)})` })
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberId, memberId)))
        .returning({ lastReadSeq: conversationMembers.lastReadSeq });
      if (seat) await deps.notifications.markConversationRead(memberId, conversationId, seat.lastReadSeq);
      // Rooms show who has read what; elsewhere nobody else is there to see it.
      if (seat && conversation.kind === 'room') {
        await service.publish(conversationId, {
          type: 'read.updated',
          data: { conversation_id: conversationId, member_id: memberId, last_read_seq: seat.lastReadSeq },
        });
      }
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
