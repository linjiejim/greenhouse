/**
 * Session service — conversation session & message persistence (PostgreSQL).
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql, ne, desc, notInArray, lt, lte, inArray, or } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';

import type { Db } from '../client.js';
import { sessions, messages, runtimeRuns } from '../schema/index.js';
import type {
  SessionRow,
  MessageRow,
  MessageInput,
  SessionChannel,
  SessionMessagePage,
} from '@greenhouse/types/session';
import type { SessionUsage } from '@greenhouse/types/api';

/** One failed tool call pulled out of a message's recorded pipeline. */
export interface ToolErrorSample {
  session_id: string;
  created_at: string;
  tool: string;
  error: string;
  /** Raw JSON of the call's input, for evidence. Redact before persisting. */
  input?: string;
}

/** A tool call that succeeded and found nothing (see `scanEmptyResults`). */
export interface EmptyResultSample {
  session_id: string;
  created_at: string;
  tool: string;
  /** Raw JSON of the call's input, for evidence. Redact before persisting. */
  input?: string;
}

export class SessionActiveRuntimeError extends Error {
  constructor() {
    super('Cannot delete a session while Chat, Automation or Subagent execution is active; cancel it first');
    this.name = 'SessionActiveRuntimeError';
  }
}

export interface SessionListOpts {
  status?: string;
  limit?: number;
  offset?: number;
  includeEval?: boolean;
  userId?: string; // filter sessions by owner
  /**
   * Keep only sessions this user does NOT own — the "Team" scope.
   *
   * Compared with IS DISTINCT FROM, not `<>`: user_id is nullable (historical
   * and engine-created sessions have no owner) and `<>` would silently drop
   * every NULL-owner row, so "everyone else's" would quietly exclude them.
   */
  excludeUserId?: string;
  channel?: string; // filter by channel (a SessionChannel, e.g. 'web' | 'task' | 'browser')
  /**
   * Channels to hide. Engine-internal sessions (channel 'workflow') are not
   * user-facing objects, so list consumers exclude them by default.
   */
  excludeChannels?: string[];
  taskId?: number; // filter by scheduled task (via metadata)
}

/** Sentinel recipient meaning "shared with every internal user". */
const TEAM_SHARE_RECIPIENT = '__team__';

export interface PaginationOpts {
  limit?: number;
  offset?: number;
}

export interface ForkSessionInput {
  sourceSessionId: string;
  userId: string;
  throughSeq?: number;
  sourceMessageId?: string;
}

export interface MessageCursorOpts {
  limit?: number;
  beforeSeq?: number;
}

export interface ChatHistoryOpts {
  excludeMessageId?: string;
}

export interface PersistedChatImage {
  id: string;
  url: string;
}

export interface PersistedChatMessage {
  role: string;
  content: string;
  created_at?: string;
  images: PersistedChatImage[];
}

export type PrepareRegenerationResult =
  | {
      ok: true;
      last_user: {
        id: string;
        content: string;
        images: PersistedChatImage[];
      } | null;
    }
  | {
      ok: false;
      reason: 'session_not_found' | 'assistant_not_latest';
    };

export type ReplaceAssistantResult =
  | {
      ok: true;
      message: MessageRow;
    }
  | {
      ok: false;
      reason: 'session_not_found' | 'assistant_not_latest';
    };

export type AppendAssistantIfTailResult =
  | {
      ok: true;
      message: MessageRow;
    }
  | {
      ok: false;
      reason: 'session_not_found' | 'transcript_changed';
    };

export type EditUserMessageResult =
  | {
      ok: true;
      message: MessageRow;
    }
  | {
      ok: false;
      reason: 'session_not_found' | 'message_not_found' | 'not_user';
    };

function messageValues(input: MessageInput, seq: number, now = nowIso(), id: string = randomUUID()) {
  return {
    id,
    session_id: input.session_id,
    role: input.role,
    content: input.content,
    references_: JSON.stringify(input.references ?? []),
    pipeline: JSON.stringify(input.pipeline ?? []),
    reasoning: input.reasoning ?? null,
    model: input.model ?? null,
    images: JSON.stringify(input.images ?? []),
    confidence: input.confidence ?? null,
    grounded: input.grounded != null ? (input.grounded ? 1 : 0) : null,
    input_tokens: input.input_tokens ?? null,
    output_tokens: input.output_tokens ?? null,
    cached_tokens: input.cached_tokens ?? null,
    reasoning_tokens: input.reasoning_tokens ?? null,
    duration_ms: input.duration_ms ?? null,
    seq,
    created_at: now,
  };
}

function parsePersistedImages(raw: string): PersistedChatImage[] {
  const parsed = safeJsonParse(raw, []);
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Record<string, unknown>).id !== 'string' ||
      typeof (value as Record<string, unknown>).url !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: (value as Record<string, unknown>).id as string,
        url: (value as Record<string, unknown>).url as string,
      },
    ];
  });
}

/**
 * Status / channel / owner predicates shared by every session list query.
 *
 * `list` and `listSharedWith` must agree on what a status filter means, so the
 * predicates live here instead of being written out twice.
 */
function sessionListConditions(opts: SessionListOpts) {
  const { status, includeEval = false, userId, excludeUserId, channel, excludeChannels, taskId } = opts;
  const conditions = [];

  if (userId) conditions.push(eq(sessions.user_id, userId));
  if (excludeUserId) conditions.push(sql`${sessions.user_id} IS DISTINCT FROM ${excludeUserId}`);
  if (channel) conditions.push(eq(sessions.channel, channel));
  if (excludeChannels?.length) conditions.push(notInArray(sessions.channel, excludeChannels));
  if (taskId) conditions.push(sql`${sessions.metadata}::jsonb @> ${JSON.stringify({ task_id: taskId })}::jsonb`);
  if (status && status !== 'all') {
    conditions.push(eq(sessions.status, status));
  } else if (!includeEval) {
    conditions.push(ne(sessions.status, 'eval'));
  }
  return conditions;
}

export function createSessionService(db: Db) {
  const service = {
    async create(
      title?: string,
      profileId?: string,
      userId?: string,
      appId?: string,
      channel?: SessionChannel,
      parentSessionId?: string,
      options?: { id?: string; metadata?: string },
    ): Promise<SessionRow> {
      const now = nowIso();
      const session: SessionRow = {
        id: options?.id ?? randomUUID(),
        title: title ?? null,
        status: 'active',
        rating: null,
        comment: null,
        feedback: null,
        profile_id: profileId ?? 'team',
        user_id: userId ?? null,
        app_id: appId ?? null,
        channel: channel ?? 'web',
        parent_session_id: parentSessionId ?? null,
        metadata: options?.metadata ?? '{}',
        created_at: now,
        updated_at: now,
      };

      await db.insert(sessions).values(session);
      return session;
    },

    async getById(id: string): Promise<SessionRow | undefined> {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id));
      return rows[0] as SessionRow | undefined;
    },

    /**
     * Create an owned snapshot of an accessible conversation.
     *
     * Authorization stays in the API layer; this method atomically copies the
     * session plus messages through an optional reply boundary. Message ids are
     * regenerated so later edits/deletes in either branch cannot affect the
     * other branch.
     */
    async fork(input: ForkSessionInput): Promise<SessionRow | undefined> {
      return db.transaction(async (tx) => {
        const [source] = await tx.select().from(sessions).where(eq(sessions.id, input.sourceSessionId)).limit(1);
        if (!source) return undefined;

        const now = nowIso();
        const fork: SessionRow = {
          id: randomUUID(),
          title: source.title ? `${source.title} (Fork)` : 'Forked conversation',
          status: 'active',
          rating: null,
          comment: null,
          feedback: null,
          profile_id: source.profile_id,
          user_id: input.userId,
          app_id: null,
          channel: 'web',
          parent_session_id: source.id,
          metadata: JSON.stringify({
            forked_from_session_id: source.id,
            ...(input.sourceMessageId ? { forked_from_message_id: input.sourceMessageId } : {}),
          }),
          created_at: now,
          updated_at: now,
        };
        await tx.insert(sessions).values(fork);

        const messageCondition =
          input.throughSeq == null
            ? eq(messages.session_id, source.id)
            : and(eq(messages.session_id, source.id), lte(messages.seq, input.throughSeq));
        const sourceMessages = await tx.select().from(messages).where(messageCondition).orderBy(messages.seq);

        if (sourceMessages.length > 0) {
          await tx.insert(messages).values(
            sourceMessages.map((message) => ({
              ...message,
              id: randomUUID(),
              session_id: fork.id,
            })),
          );
        }

        return fork;
      });
    },

    async list(opts: SessionListOpts = {}): Promise<SessionRow[]> {
      const { limit = 200, offset = 0 } = opts;
      const conditions = sessionListConditions(opts);

      let query = db.select().from(sessions);
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      return (await (query as any).orderBy(desc(sessions.updated_at)).limit(limit).offset(offset)) as SessionRow[];
    },

    /**
     * Sessions someone else shared with this user — directly or team-wide.
     *
     * A semi-join, not a real join: a session can carry both a direct share and
     * a team share, and joining would return it twice. Self-created shares are
     * excluded here (getSharedSessionIds deliberately keeps them, because it
     * answers "can I read this", not "did someone share this with me").
     */
    async listSharedWith(userId: string, opts: SessionListOpts = {}): Promise<SessionRow[]> {
      const { limit = 200, offset = 0 } = opts;
      const conditions = [
        ...sessionListConditions(opts),
        sql`${sessions.user_id} IS DISTINCT FROM ${userId}`,
        sql`EXISTS (
          SELECT 1 FROM session_shares ss
          WHERE ss.session_id = ${sessions.id}
            AND (ss.shared_with = ${userId} OR ss.shared_with = ${TEAM_SHARE_RECIPIENT})
        )`,
      ];

      return (await db
        .select()
        .from(sessions)
        .where(and(...conditions))
        .orderBy(desc(sessions.updated_at))
        .limit(limit)
        .offset(offset)) as SessionRow[];
    },

    async updateTitle(id: string, title: string): Promise<void> {
      await db.update(sessions).set({ title, updated_at: nowIso() }).where(eq(sessions.id, id));
    },

    async updateStatus(id: string, status: string): Promise<void> {
      await db.update(sessions).set({ status, updated_at: nowIso() }).where(eq(sessions.id, id));
    },

    async touch(id: string): Promise<void> {
      await db.update(sessions).set({ updated_at: nowIso() }).where(eq(sessions.id, id));
    },

    async update(
      id: string,
      updates: {
        status?: string;
        rating?: number | null;
        comment?: string | null;
        title?: string | null;
        feedback?: string | null;
        metadata?: string;
      },
    ): Promise<SessionRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.rating !== undefined) set.rating = updates.rating;
      if (updates.comment !== undefined) set.comment = updates.comment;
      if (updates.title !== undefined) set.title = updates.title;
      if (updates.feedback !== undefined) set.feedback = updates.feedback;
      if (updates.metadata !== undefined) set.metadata = updates.metadata;

      await db.update(sessions).set(set).where(eq(sessions.id, id));
      return service.getById(id);
    },

    /**
     * Hard-delete a session.
     *
     * session_shares / session_share_reads are cleaned up by their FK cascade
     * (migration 0052) — don't add an application-level delete for them, the
     * whole point of the constraint is that no caller has to remember.
     */
    async delete(id: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [lockedSession] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, id))
          .for('update');
        if (!lockedSession) return;
        const [activeRuntime] = await tx
          .select({ id: runtimeRuns.id })
          .from(runtimeRuns)
          .where(
            and(
              inArray(runtimeRuns.status, ['queued', 'claimed', 'running', 'waiting', 'paused']),
              or(
                and(eq(runtimeRuns.kind, 'chat'), eq(runtimeRuns.session_id, id)),
                and(eq(runtimeRuns.kind, 'automation'), eq(runtimeRuns.session_id, id)),
                and(
                  eq(runtimeRuns.kind, 'subagent'),
                  eq(runtimeRuns.source_kind, 'spawned_session'),
                  or(eq(runtimeRuns.session_id, id), sql`${runtimeRuns.input}::jsonb ->> 'parent_session_id' = ${id}`),
                ),
              ),
            ),
          )
          .limit(1)
          .for('update');
        if (activeRuntime) throw new SessionActiveRuntimeError();
        await tx.delete(messages).where(eq(messages.session_id, id));
        await tx.delete(sessions).where(eq(sessions.id, id));
      });
    },

    async deleteMessagesAfterSeq(sessionId: string, seq: number): Promise<void> {
      await db.delete(messages).where(and(eq(messages.session_id, sessionId), sql`seq >= ${seq}`));
    },

    /**
     * Validate that an assistant turn can be regenerated without mutating it.
     *
     * The actual replacement happens only after a new answer finishes. Both
     * stages validate the exact transcript tail, so a failed provider request
     * preserves the old answer and a stale/double replacement cannot delete a
     * newer turn.
     */
    async prepareRegeneration(sessionId: string, assistantMessageId: string): Promise<PrepareRegenerationResult> {
      return db.transaction(async (tx) => {
        const [lockedSession] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for('update');
        if (!lockedSession) return { ok: false, reason: 'session_not_found' };

        const [lastMessage] = await tx
          .select()
          .from(messages)
          .where(eq(messages.session_id, sessionId))
          .orderBy(desc(messages.seq))
          .limit(1);
        if (!lastMessage || lastMessage.id !== assistantMessageId || lastMessage.role !== 'assistant') {
          return { ok: false, reason: 'assistant_not_latest' };
        }

        const [lastUser] = await tx
          .select({
            id: messages.id,
            content: messages.content,
            images: messages.images,
          })
          .from(messages)
          .where(and(eq(messages.session_id, sessionId), eq(messages.role, 'user'), lt(messages.seq, lastMessage.seq)))
          .orderBy(desc(messages.seq))
          .limit(1);

        return {
          ok: true,
          last_user: lastUser
            ? {
                id: lastUser.id,
                content: lastUser.content,
                images: parsePersistedImages(lastUser.images),
              }
            : null,
        };
      });
    },

    /**
     * Replace the exact latest assistant turn in one transaction.
     *
     * Deleting and inserting the same sequence number is atomic: an insert
     * failure rolls the delete back, leaving the previous response intact.
     */
    async replaceLatestAssistant(
      sessionId: string,
      assistantMessageId: string,
      input: MessageInput,
      replacementMessageId?: string,
    ): Promise<ReplaceAssistantResult> {
      if (input.session_id !== sessionId || input.role !== 'assistant') {
        throw new Error('Assistant replacement must target the same session');
      }

      return db.transaction(async (tx) => {
        const [lockedSession] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for('update');
        if (!lockedSession) return { ok: false, reason: 'session_not_found' };

        if (replacementMessageId) {
          const [existingReplacement] = await tx
            .select()
            .from(messages)
            .where(eq(messages.id, replacementMessageId))
            .limit(1);
          if (existingReplacement) {
            if (
              existingReplacement.session_id !== sessionId ||
              existingReplacement.role !== 'assistant' ||
              existingReplacement.content !== input.content
            ) {
              throw new Error('Assistant replacement idempotency key was reused with different content');
            }
            return { ok: true, message: existingReplacement as MessageRow };
          }
        }

        const [lastMessage] = await tx
          .select()
          .from(messages)
          .where(eq(messages.session_id, sessionId))
          .orderBy(desc(messages.seq))
          .limit(1);
        if (!lastMessage || lastMessage.id !== assistantMessageId || lastMessage.role !== 'assistant') {
          return { ok: false, reason: 'assistant_not_latest' };
        }

        await tx.delete(messages).where(eq(messages.id, assistantMessageId));
        const [inserted] = await tx
          .insert(messages)
          .values(messageValues(input, lastMessage.seq, nowIso(), replacementMessageId ?? randomUUID()))
          .returning();
        await tx.update(sessions).set({ updated_at: nowIso() }).where(eq(sessions.id, sessionId));

        return { ok: true, message: inserted as MessageRow };
      });
    },

    /**
     * Append an assistant only while the exact transcript revision used to
     * generate it is still the tail.
     *
     * Matching both ID and content matters: editing a user message intentionally
     * keeps its public ID stable, so an ID-only compare-and-set would still
     * accept an answer generated from the pre-edit prompt.
     */
    async appendAssistantIfTail(
      sessionId: string,
      expectedTail: { id: string; content: string },
      input: MessageInput,
      messageId?: string,
    ): Promise<AppendAssistantIfTailResult> {
      if (input.session_id !== sessionId || input.role !== 'assistant') {
        throw new Error('Assistant append must target the same session');
      }

      return db.transaction(async (tx) => {
        const [lockedSession] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for('update');
        if (!lockedSession) return { ok: false, reason: 'session_not_found' };

        if (messageId) {
          const [existingAssistant] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
          if (existingAssistant) {
            if (
              existingAssistant.session_id !== sessionId ||
              existingAssistant.role !== 'assistant' ||
              existingAssistant.content !== input.content
            ) {
              throw new Error('Assistant append idempotency key was reused with different content');
            }
            return { ok: true, message: existingAssistant as MessageRow };
          }
        }

        const [lastMessage] = await tx
          .select()
          .from(messages)
          .where(eq(messages.session_id, sessionId))
          .orderBy(desc(messages.seq))
          .limit(1);
        if (!lastMessage || lastMessage.id !== expectedTail.id || lastMessage.content !== expectedTail.content) {
          return { ok: false, reason: 'transcript_changed' };
        }

        const [inserted] = await tx
          .insert(messages)
          .values(messageValues(input, lastMessage.seq + 1, nowIso(), messageId ?? randomUUID()))
          .returning();
        await tx.update(sessions).set({ updated_at: nowIso() }).where(eq(sessions.id, sessionId));

        return { ok: true, message: inserted as MessageRow };
      });
    },

    async getMessageById(id: string): Promise<MessageRow | undefined> {
      const rows = await db.select().from(messages).where(eq(messages.id, id));
      return rows[0] as MessageRow | undefined;
    },

    async getLatestMessage(sessionId: string): Promise<MessageRow | undefined> {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.session_id, sessionId))
        .orderBy(desc(messages.seq))
        .limit(1);
      return rows[0] as MessageRow | undefined;
    },

    /**
     * Edit one user turn and truncate every dependent turn atomically.
     *
     * The session row is locked before the message is re-read, so a concurrent
     * assistant append/replacement either commits first and is truncated or
     * observes the edited transcript and fails its tail compare-and-set.
     */
    async editUserMessageAndTruncate(
      sessionId: string,
      messageId: string,
      content: string,
    ): Promise<EditUserMessageResult> {
      return db.transaction(async (tx) => {
        const [lockedSession] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for('update');
        if (!lockedSession) return { ok: false, reason: 'session_not_found' };

        const [message] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.session_id, sessionId)))
          .limit(1);
        if (!message) return { ok: false, reason: 'message_not_found' };
        if (message.role !== 'user') return { ok: false, reason: 'not_user' };

        const [updated] = await tx.update(messages).set({ content }).where(eq(messages.id, messageId)).returning();
        await tx.delete(messages).where(and(eq(messages.session_id, sessionId), sql`${messages.seq} > ${message.seq}`));
        await tx.update(sessions).set({ updated_at: nowIso() }).where(eq(sessions.id, sessionId));

        return { ok: true, message: updated as MessageRow };
      });
    },

    async updateMessageContent(id: string, content: string): Promise<void> {
      await db.update(messages).set({ content }).where(eq(messages.id, id));
    },

    async addMessage(input: MessageInput): Promise<MessageRow> {
      return db.transaction(async (tx) => {
        // The session row is the per-transcript serialization lock. Together
        // with uq_messages_session_seq this guarantees a stable seq cursor even
        // when web, mobile, and API writers append concurrently.
        const [lockedSession] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, input.session_id))
          .limit(1)
          .for('update');
        if (!lockedSession) throw new Error('Session not found');

        const [next] = await tx
          .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), -1) + 1` })
          .from(messages)
          .where(eq(messages.session_id, input.session_id));
        const inserted = await tx
          .insert(messages)
          .values(messageValues(input, Number(next?.seq ?? 0)))
          .returning();
        await tx.update(sessions).set({ updated_at: nowIso() }).where(eq(sessions.id, input.session_id));
        return inserted[0] as MessageRow;
      });
    },

    /**
     * Idempotently append a server-owned message with a caller-stable ID.
     *
     * Cloud Agent outcome delivery can crash after inserting the transcript
     * row but before acknowledging its outbox item. Retrying with the same ID
     * returns the existing row instead of appending a duplicate result.
     */
    async addMessageOnce(messageId: string, input: MessageInput): Promise<MessageRow> {
      return db.transaction(async (tx) => {
        const [lockedSession] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, input.session_id))
          .limit(1)
          .for('update');
        if (!lockedSession) throw new Error('Session not found');

        const [existing] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
        if (existing) {
          if (existing.session_id !== input.session_id) throw new Error('Message ID belongs to another session');
          return existing as MessageRow;
        }

        const [next] = await tx
          .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), -1) + 1` })
          .from(messages)
          .where(eq(messages.session_id, input.session_id));
        const [inserted] = await tx
          .insert(messages)
          .values(messageValues(input, Number(next?.seq ?? 0), nowIso(), messageId))
          .returning();
        await tx.update(sessions).set({ updated_at: nowIso() }).where(eq(sessions.id, input.session_id));
        return inserted as MessageRow;
      });
    },

    async getMessages(sessionId: string, opts: PaginationOpts = {}): Promise<MessageRow[]> {
      const { limit = 100, offset = 0 } = opts;
      return (await db
        .select()
        .from(messages)
        .where(eq(messages.session_id, sessionId))
        .orderBy(messages.seq)
        .limit(limit)
        .offset(offset)) as MessageRow[];
    },

    async getMessagePage(sessionId: string, opts: MessageCursorOpts = {}): Promise<SessionMessagePage> {
      const { limit = 50, beforeSeq } = opts;
      const conditions = [eq(messages.session_id, sessionId)];
      if (beforeSeq !== undefined) {
        conditions.push(lt(messages.seq, beforeSeq));
      }

      // Read newest-first so the database only scans one bounded page, then
      // restore transcript order for clients. The extra row is the has_more probe.
      const newestFirst = (await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.seq))
        .limit(limit + 1)) as MessageRow[];
      const hasMore = newestFirst.length > limit;
      const pageMessages = newestFirst.slice(0, limit).reverse();

      return {
        messages: pageMessages,
        has_more: hasMore,
        next_before_seq: hasMore ? (pageMessages[0]?.seq ?? null) : null,
      };
    },

    async getMessageCount(sessionId: string): Promise<number> {
      const row = (
        await db
          .select({ cnt: sql<number>`COUNT(*)` })
          .from(messages)
          .where(eq(messages.session_id, sessionId))
      )[0];
      return Number(row?.cnt ?? 0);
    },

    async buildChatMessages(sessionId: string, opts: ChatHistoryOpts = {}): Promise<PersistedChatMessage[]> {
      const conditions = [eq(messages.session_id, sessionId), sql`role IN ('user', 'assistant')`];
      if (opts.excludeMessageId) conditions.push(ne(messages.id, opts.excludeMessageId));

      const rows = await db
        .select({
          role: messages.role,
          content: messages.content,
          created_at: messages.created_at,
          images: messages.images,
        })
        .from(messages)
        .where(and(...conditions))
        .orderBy(messages.seq);
      return rows.map((row) => ({
        ...row,
        images: parsePersistedImages(row.images),
      }));
    },

    async getUsage(sessionId: string): Promise<SessionUsage> {
      const rows = await db
        .select({
          totalInputTokens: sql<number>`COALESCE(SUM(input_tokens), 0)`,
          totalOutputTokens: sql<number>`COALESCE(SUM(output_tokens), 0)`,
          totalCachedTokens: sql<number>`COALESCE(SUM(cached_tokens), 0)`,
          totalReasoningTokens: sql<number>`COALESCE(SUM(reasoning_tokens), 0)`,
          totalDurationMs: sql<number>`COALESCE(SUM(duration_ms), 0)`,
          messageCount: sql<number>`COUNT(*)`,
        })
        .from(messages)
        .where(and(eq(messages.session_id, sessionId), eq(messages.role, 'assistant')));
      return rows[0] as SessionUsage;
    },

    /**
     * Whether an image id was produced or attached in this conversation.
     *
     * Images do not get a `chat_files` row — they live on the flat public-read
     * `/api/upload/:id` path because `<img src>` cannot send a bearer token — so
     * "is this image part of this conversation" has no handle table to ask. The
     * transcript is the record: a user upload lands in `messages.images`, and a
     * generated one lands in the assistant `pipeline` as the tool's output URL.
     *
     * This is an authorization check, not a convenience lookup: the id comes
     * from the model, so without the session bound a copied id would let one
     * conversation's picture be mailed out of another.
     */
    async sessionReferencesImage(sessionId: string, imageId: string): Promise<boolean> {
      // Ids are server-minted `timestamp-uuid[.ext]`, so a substring match
      // inside one session cannot collide with an unrelated image.
      const rows = await db.execute<{ found: number }>(sql`
        SELECT 1 AS found
        FROM ${messages}
        WHERE session_id = ${sessionId}
          AND (
            position(${imageId} in coalesce(images, '')) > 0
            OR position(${imageId} in coalesce(pipeline, '')) > 0
            OR position(${imageId} in coalesce(content, '')) > 0
          )
        LIMIT 1
      `);
      return rows.length > 0;
    },

    /**
     * Every failed tool call recorded in `messages.pipeline` since `sinceIso`.
     *
     * Feeds the friction miner: agents stumble far more often than anyone
     * reports, and the pipeline column already holds the evidence. Read-only and
     * capped — this is a signal source, not an audit ledger.
     *
     * Rows whose pipeline serialised a NUL character are skipped: PostgreSQL
     * jsonb cannot represent NUL, so the `::jsonb` cast on ONE such row would
     * abort the whole sweep — a day of frictions lost to a single mojibake
     * attachment (seen live 2026-08-11 with a UTF-16 CSV read as UTF-8).
     * The extract layer no longer emits NULs, but historical rows remain and
     * this query must not trust every future writer.
     */
    async scanToolErrors(sinceIso: string, limit = 2000): Promise<ToolErrorSample[]> {
      // The exact six characters JSON.stringify writes for a NUL — derived, not
      // typed, so no reader has to count backslashes.
      const jsonNulEscape = JSON.stringify(String.fromCharCode(0)).slice(1, -1);
      const rows = await db.execute<{
        session_id: string;
        created_at: string;
        tool: string | null;
        error: string | null;
        input: string | null;
      }>(sql`
        SELECT m.session_id,
               m.created_at,
               elem->>'tool'            AS tool,
               elem->'output'->>'error' AS error,
               elem->>'input'           AS input
        FROM ${messages} m,
             LATERAL jsonb_array_elements(m.pipeline::jsonb) AS elem
        WHERE m.role = 'assistant'
          AND m.pipeline LIKE '[%'
          AND m.pipeline <> '[]'
          AND strpos(m.pipeline, ${jsonNulEscape}) = 0
          AND m.created_at > ${sinceIso}
          AND jsonb_typeof(elem->'output') = 'object'
          AND jsonb_exists(elem->'output', 'error')
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `);
      return rows
        .filter((r) => r.tool && r.error)
        .map((r) => ({
          session_id: r.session_id,
          created_at: r.created_at,
          tool: r.tool!,
          error: r.error!,
          input: r.input ?? undefined,
        }));
    },

    /**
     * Retrieval calls that came back with nothing (`found: 0`).
     *
     * The error sweep above only sees calls that FAILED; a search that runs
     * fine and returns an empty set is the quintessential "no error but it did
     * not work" — the thing `log_friction` exists for, except no model thinks
     * to report its own empty search. The caller decides which tools count as
     * retrieval; this query just finds the shape.
     */
    async scanEmptyResults(sinceIso: string, limit = 2000): Promise<EmptyResultSample[]> {
      const jsonNulEscape = JSON.stringify(String.fromCharCode(0)).slice(1, -1);
      const rows = await db.execute<{
        session_id: string;
        created_at: string;
        tool: string | null;
        input: string | null;
      }>(sql`
        SELECT m.session_id,
               m.created_at,
               elem->>'tool'  AS tool,
               elem->>'input' AS input
        FROM ${messages} m,
             LATERAL jsonb_array_elements(m.pipeline::jsonb) AS elem
        WHERE m.role = 'assistant'
          AND m.pipeline LIKE '[%'
          AND m.pipeline <> '[]'
          AND strpos(m.pipeline, ${jsonNulEscape}) = 0
          AND m.created_at > ${sinceIso}
          AND jsonb_typeof(elem->'output') = 'object'
          AND NOT jsonb_exists(elem->'output', 'error')
          AND elem->'output'->>'found' = '0'
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `);
      return rows
        .filter((r) => r.tool)
        .map((r) => ({
          session_id: r.session_id,
          created_at: r.created_at,
          tool: r.tool!,
          input: r.input ?? undefined,
        }));
    },

    async searchByTitle(userId: string, query: string, limit = 10, channel?: string): Promise<SessionRow[]> {
      const pattern = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      const conditions = [
        eq(sessions.user_id, userId),
        ne(sessions.status, 'eval'),
        sql`${sessions.title} ILIKE ${pattern}`,
      ];
      if (channel) conditions.push(eq(sessions.channel, channel));
      return (await db
        .select()
        .from(sessions)
        .where(and(...conditions))
        .orderBy(desc(sessions.updated_at))
        .limit(limit)) as SessionRow[];
    },
  };
  return service;
}

export type SessionService = ReturnType<typeof createSessionService>;
