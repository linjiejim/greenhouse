/**
 * Session service — conversation & message persistence (PostgreSQL tables
 * `conversations` / `messages`; the facade keeps the historical "session" name).
 */

import { eq, and, sql, ne, desc, notInArray, lt, lte, inArray, or, getTableColumns } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { toRowId } from '@greenhouse/utils/id';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { conversations as sessions, messages, conversationShares, runs as runtimeRuns } from '../schema/index.js';
import { segmentForFts, buildSnippet } from './fts.js';
import type {
  SessionRow,
  MessageRow,
  MessageInput,
  MessageImage,
  MessageParts,
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
   * Channels to hide. Workflow node transcripts (channel 'workflow', retired
   * in v1.4) are not user-facing objects, so list consumers exclude them by default.
   */
  excludeChannels?: string[];
  /** Filter by automation (via `metadata.task_id`); a legacy number is accepted. */
  taskId?: string | number;
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
  /**
   * Only messages with `seq > afterSeq` — the part of the transcript the
   * rolling digest has not folded yet (`sessions.digest_upto_seq`).
   */
  afterSeq?: number | null;
}

/**
 * The rolling-digest columns (migration 0008). Not part of the shared
 * `SessionRow` contract: clients never need them, and only the chat prompt
 * assembly and the fold read them. Optional because rows built in memory (and
 * test doubles) do not carry them.
 */
export interface SessionDigestFields {
  digest?: string | null;
  digest_upto_seq?: number | null;
  digest_updated_at?: string | null;
}

/** A full `sessions` row as read from the database. */
export type SessionRecord = SessionRow & SessionDigestFields;

/** The usable digest of a session, or null when it has none. */
export function readSessionDigest(
  row: SessionDigestFields | null | undefined,
): { text: string; uptoSeq: number } | null {
  if (!row || typeof row.digest !== 'string' || !row.digest.trim()) return null;
  if (typeof row.digest_upto_seq !== 'number' || !Number.isInteger(row.digest_upto_seq)) return null;
  return { text: row.digest, uptoSeq: row.digest_upto_seq };
}

/** A transcript message with its position, for the digest fold. */
export interface SequencedChatMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface AdvanceDigestInput {
  /** The `digest_upto_seq` the fold started from (null = no digest yet). */
  expectedUptoSeq: number | null;
  /** The last folded message's seq; must be greater than the current value. */
  uptoSeq: number;
  /**
   * The last folded message as the fold read it. An edit at or below it
   * either rewrites it (same id, new content) or truncates it away, so a
   * mismatch means the fold summarised a transcript that no longer exists.
   */
  boundary: { id: string; content: string };
  digest: string;
}

/** One message that matched a content search. */
export interface MessageSearchHit {
  session_id: string;
  message_id: string;
  seq: number;
  role: string;
  snippet: string;
  created_at: string;
  /** How many of the query's terms the message contains. */
  matched_terms: number;
}

/** A content-search hit across conversations, with the session it belongs to. */
export interface SessionMessageSearchHit extends MessageSearchHit {
  title: string | null;
  profile_id: string;
  channel: string;
  session_updated_at: string;
}

export interface MessageSearchOpts {
  limit?: number;
  channel?: string;
}

/** Most query terms a content search matches on — bounds the SQL it builds. */
const MAX_SEARCH_TERMS = 8;

/**
 * Segment a free-text query into the terms a content search matches on.
 *
 * Uses the same jieba segmentation as the knowledge base (`segmentForFts`).
 * Messages have no stored token column (the schema is frozen for v1.4), so the
 * terms are matched as case-insensitive substrings of the raw content instead
 * of through a tsvector — the CJK equivalent of the knowledge base's `term:*`
 * prefix match. Returns `all` for the AND pass and `recall` for the OR pass,
 * which drops single-character terms (particles like 的/了 match everything)
 * whenever a longer term exists.
 */
export function messageSearchTerms(query: string): { all: string[]; recall: string[] } {
  const all = [...new Set(segmentForFts(query).split(/\s+/).filter(Boolean))].slice(0, MAX_SEARCH_TERMS);
  const long = all.filter((term) => [...term].length >= 2);
  return { all, recall: long.length > 0 ? long : all };
}

export type PersistedChatImage = MessageImage;

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

/**
 * jsonb cannot hold U+0000, and one tool output carrying it (a UTF-16 file read
 * as UTF-8) would make the whole message insert fail. Drop it from every string.
 */
function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [stripNul(key) as string, stripNul(item)]));
  }
  return value;
}

/** The `parts` column for a new message; empty parts are left out. */
function messageParts(input: MessageInput): MessageParts {
  const parts: MessageParts = {};
  if (input.references?.length) parts.references = input.references;
  if (input.images?.length) parts.images = input.images;
  if (input.pipeline?.length) parts.pipeline = input.pipeline;
  return stripNul(parts) as MessageParts;
}

function messageValues(input: MessageInput, seq: number, now = nowIso(), id: string = newId('message')) {
  return {
    id,
    session_id: input.session_id,
    role: input.role,
    content: input.content,
    parts: messageParts(input),
    reasoning: input.reasoning ?? null,
    model: input.model ?? null,
    input_tokens: input.input_tokens ?? null,
    output_tokens: input.output_tokens ?? null,
    cached_tokens: input.cached_tokens ?? null,
    reasoning_tokens: input.reasoning_tokens ?? null,
    duration_ms: input.duration_ms ?? null,
    seq,
    client_turn_id: input.client_turn_id ?? null,
    created_at: now,
  };
}

async function findClientTurn(
  reader: Pick<Db, 'select'>,
  sessionId: string,
  clientTurnId: string,
): Promise<MessageRow | undefined> {
  const [row] = await reader
    .select()
    .from(messages)
    .where(and(eq(messages.session_id, sessionId), eq(messages.client_turn_id, clientTurnId)))
    .limit(1);
  return row as MessageRow | undefined;
}

/** True when `error` is the unique-index violation for a repeated client turn id. */
function isDuplicateClientTurn(error: unknown): boolean {
  for (let current = error; current && typeof current === 'object'; current = (current as { cause?: unknown }).cause) {
    const pg = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (pg.code === '23505' && (pg.constraint_name ?? pg.constraint) === 'uq_messages_session_client_turn') return true;
  }
  return false;
}

function parsePersistedImages(parts: MessageParts | null | undefined): PersistedChatImage[] {
  const parsed: unknown = parts?.images;
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
  // `->>` reads a number and a string alike: carried 1.x rows store the
  // automation id as a number, new ones as text.
  if (taskId != null && taskId !== '') conditions.push(sql`${sessions.metadata} ->> 'task_id' = ${toRowId(taskId)}`);
  if (status && status !== 'all') {
    conditions.push(eq(sessions.status, status));
  } else if (!includeEval) {
    conditions.push(ne(sessions.status, 'eval'));
  }
  return conditions;
}

/**
 * Columns for session LIST reads: everything except the digest text, which no
 * list consumer reads and which would add kilobytes per row to a 200-row page.
 */
const { digest: _digestColumn, ...sessionListColumns } = getTableColumns(sessions);

/**
 * List rows also carry `last_message`: the start of the newest member or assistant message
 * (240 characters, not cleaned up), so a list can show what a conversation is at. One indexed
 * lookup per row (`uq_messages_session_seq`); null for a conversation with no words yet.
 * The outer row is named by table (`${sessions}.id`): a bare column would bind to `m.id`.
 */
const sessionListRowColumns = {
  ...sessionListColumns,
  last_message: sql<string | null>`(
    SELECT left(m.content, 240) FROM ${messages} m
    WHERE m.session_id = ${sessions}.id AND m.role IN ('user', 'assistant') AND m.content <> ''
    ORDER BY m.seq DESC LIMIT 1
  )`.as('last_message'),
};

/**
 * Drop the rolling digest when the transcript changes at or below the point it
 * summarises. A digest cannot be partially un-summarised, so any edit inside
 * the folded range clears it; the next turn falls back to the plain history
 * window and the post-turn fold rebuilds the digest from the edited transcript.
 * Runs inside the caller's transaction, after the session row is locked.
 */
async function resetDigestIfFolded(tx: Pick<Db, 'update'>, sessionId: string, seq: number): Promise<void> {
  await tx
    .update(sessions)
    .set({ digest: null, digest_upto_seq: null, digest_updated_at: nowIso() })
    .where(and(eq(sessions.id, sessionId), sql`${sessions.digest_upto_seq} >= ${seq}`));
}

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** `strpos(lower(content), term) > 0` for each term, joined with AND / OR. */
function contentTermConditions(terms: string[], op: 'and' | 'or') {
  const parts = terms.map((term) => sql`strpos(lower(${messages.content}), ${term}) > 0`);
  // Parenthesised: drizzle's and() does not wrap raw fragments, so a bare
  // `a OR b` would bind to its neighbours.
  return sql`(${sql.join(parts, op === 'and' ? sql` AND ` : sql` OR `)})`;
}

/** Number of terms a message contains — the content search's rank. */
function matchedTermCount(terms: string[]) {
  const parts = terms.map((term) => sql`(CASE WHEN strpos(lower(${messages.content}), ${term}) > 0 THEN 1 ELSE 0 END)`);
  return sql<number>`(${sql.join(parts, sql` + `)})`;
}

export function createSessionService(db: Db) {
  const service = {
    async create(
      title?: string,
      profileId?: string,
      userId?: string,
      appId?: string,
      channel?: SessionChannel,
      options?: { id?: string; metadata?: Record<string, unknown> },
    ): Promise<SessionRow> {
      const now = nowIso();
      const [row] = await db
        .insert(sessions)
        .values({
          id: options?.id ?? newId('conversation'),
          title: title ?? null,
          status: 'active',
          profile_id: profileId ?? 'sprouty',
          user_id: userId ?? null,
          app_id: appId ?? null,
          channel: channel ?? 'web',
          metadata: options?.metadata ?? {},
          created_at: now,
          updated_at: now,
        })
        .returning(sessionListColumns);
      return row as SessionRow;
    },

    async getById(id: string): Promise<SessionRecord | undefined> {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id));
      return rows[0] as SessionRecord | undefined;
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
        const fork = {
          id: newId('conversation'),
          title: source.title ? `${source.title} (Fork)` : 'Forked conversation',
          status: 'active',
          profile_id: source.profile_id,
          user_id: input.userId,
          app_id: null,
          channel: 'web' as SessionChannel,
          metadata: {
            forked_from_session_id: source.id,
            ...(input.sourceMessageId ? { forked_from_message_id: input.sourceMessageId } : {}),
          },
          pinned_at: null,
          pin_position: 0,
          created_at: now,
          updated_at: now,
        } satisfies SessionRow;
        // A fork that keeps everything the source's digest folded carries the
        // digest along — message seqs are copied verbatim, so it still lines up.
        const sourceDigest = readSessionDigest(source);
        const inheritsDigest =
          sourceDigest !== null && (input.throughSeq == null || input.throughSeq >= sourceDigest.uptoSeq);
        await tx.insert(sessions).values({
          ...fork,
          ...(inheritsDigest
            ? { digest: sourceDigest.text, digest_upto_seq: sourceDigest.uptoSeq, digest_updated_at: now }
            : {}),
        });

        const messageCondition =
          input.throughSeq == null
            ? eq(messages.session_id, source.id)
            : and(eq(messages.session_id, source.id), lte(messages.seq, input.throughSeq));
        const sourceMessages = await tx.select().from(messages).where(messageCondition).orderBy(messages.seq);

        if (sourceMessages.length > 0) {
          await tx.insert(messages).values(
            sourceMessages.map((message) => ({
              ...message,
              id: newId('message'),
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

      let query = db.select(sessionListRowColumns).from(sessions);
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
          SELECT 1 FROM ${conversationShares} ss
          WHERE ss.session_id = ${sessions.id}
            AND (ss.shared_with = ${userId} OR ss.shared_with = ${TEAM_SHARE_RECIPIENT})
        )`,
      ];

      return (await db
        .select(sessionListRowColumns)
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
        title?: string | null;
        metadata?: Record<string, unknown>;
      },
    ): Promise<SessionRow | undefined> {
      const set: Partial<typeof sessions.$inferInsert> = { updated_at: nowIso() };
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.title !== undefined) set.title = updates.title;
      if (updates.metadata !== undefined) set.metadata = updates.metadata;

      await db.update(sessions).set(set).where(eq(sessions.id, id));
      return service.getById(id);
    },

    /**
     * Hard-delete a session.
     *
     * conversation_shares / conversation_share_reads, files and receipts are
     * cleaned up by their FK cascade — don't add an application-level delete for them, the
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
                  or(eq(runtimeRuns.session_id, id), sql`${runtimeRuns.input} ->> 'parent_session_id' = ${id}`),
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
      await db.transaction(async (tx) => {
        await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1).for('update');
        await tx.delete(messages).where(and(eq(messages.session_id, sessionId), sql`seq >= ${seq}`));
        await resetDigestIfFolded(tx, sessionId, seq);
      });
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
            parts: messages.parts,
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
                images: parsePersistedImages(lastUser.parts as MessageParts),
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
        // Never true while the fold keeps the last exchanges verbatim; kept so a
        // replaced answer can never stay summarised under its old content.
        await resetDigestIfFolded(tx, sessionId, lastMessage.seq);
        const [inserted] = await tx
          .insert(messages)
          .values(messageValues(input, lastMessage.seq, nowIso(), replacementMessageId ?? newId('message')))
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
          .values(messageValues(input, lastMessage.seq + 1, nowIso(), messageId ?? newId('message')))
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
        await resetDigestIfFolded(tx, sessionId, message.seq);

        return { ok: true, message: updated as MessageRow };
      });
    },

    async updateMessageContent(id: string, content: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [message] = await tx
          .update(messages)
          .set({ content })
          .where(eq(messages.id, id))
          .returning({ session_id: messages.session_id, seq: messages.seq });
        if (message) await resetDigestIfFolded(tx, message.session_id, message.seq);
      });
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

    /** The message this session saved for a client turn id, if any. */
    async getMessageByClientTurn(sessionId: string, clientTurnId: string): Promise<MessageRow | undefined> {
      return findClientTurn(db, sessionId, clientTurnId);
    },

    /**
     * Append a user turn that carries the client's `client_turn_id`, unless this
     * session already has a message with that id: then nothing is written and
     * the earlier message comes back as `duplicate`. The session row lock
     * serializes writers; uq_messages_session_client_turn backs it up.
     */
    async addUserTurn(
      input: MessageInput & { client_turn_id: string },
    ): Promise<{ ok: true; message: MessageRow } | { ok: false; duplicate: MessageRow }> {
      const findTurn = (reader: Pick<Db, 'select'>) => findClientTurn(reader, input.session_id, input.client_turn_id);
      try {
        return await db.transaction(async (tx) => {
          const [lockedSession] = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.id, input.session_id))
            .limit(1)
            .for('update');
          if (!lockedSession) throw new Error('Session not found');
          const existing = await findTurn(tx);
          if (existing) return { ok: false as const, duplicate: existing };
          const [next] = await tx
            .select({ seq: sql<number>`COALESCE(MAX(${messages.seq}), -1) + 1` })
            .from(messages)
            .where(eq(messages.session_id, input.session_id));
          const [inserted] = await tx
            .insert(messages)
            .values(messageValues(input, Number(next?.seq ?? 0)))
            .returning();
          await tx.update(sessions).set({ updated_at: nowIso() }).where(eq(sessions.id, input.session_id));
          return { ok: true as const, message: inserted as MessageRow };
        });
      } catch (error) {
        if (!isDuplicateClientTurn(error)) throw error;
        const existing = await findTurn(db);
        if (!existing) throw error;
        return { ok: false, duplicate: existing };
      }
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
      if (opts.afterSeq != null) conditions.push(sql`${messages.seq} > ${opts.afterSeq}`);

      const rows = await db
        .select({
          role: messages.role,
          content: messages.content,
          created_at: messages.created_at,
          parts: messages.parts,
        })
        .from(messages)
        .where(and(...conditions))
        .orderBy(messages.seq);
      return rows.map(({ parts, ...row }) => ({
        ...row,
        images: parsePersistedImages(parts as MessageParts),
      }));
    },

    /** User/assistant messages after `afterSeq` (all when null), in transcript order, with ids and seqs. */
    async listChatMessagesAfter(sessionId: string, afterSeq: number | null): Promise<SequencedChatMessage[]> {
      const conditions = [eq(messages.session_id, sessionId), sql`role IN ('user', 'assistant')`];
      if (afterSeq != null) conditions.push(sql`${messages.seq} > ${afterSeq}`);
      const rows = await db
        .select({
          id: messages.id,
          seq: messages.seq,
          role: messages.role,
          content: messages.content,
          created_at: messages.created_at,
        })
        .from(messages)
        .where(and(...conditions))
        .orderBy(messages.seq);
      return rows as SequencedChatMessage[];
    },

    /**
     * Move the rolling digest forward with a compare-and-set.
     *
     * Succeeds only when (a) `digest_upto_seq` is still what the fold read —
     * a concurrent fold or an edit-triggered reset makes this one lose — (b)
     * the new position is strictly ahead of it, and (c) the last folded
     * message is still there with the content that was summarised. Returns
     * whether the digest was written; a lost race is not an error.
     */
    async advanceDigest(sessionId: string, input: AdvanceDigestInput): Promise<boolean> {
      if (!Number.isInteger(input.uptoSeq) || input.uptoSeq < 0)
        throw new Error('uptoSeq must be a non-negative integer');
      if (input.expectedUptoSeq != null && input.uptoSeq <= input.expectedUptoSeq) return false;
      if (!input.digest.trim()) throw new Error('A digest cannot be empty');

      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ digest_upto_seq: sessions.digest_upto_seq })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for('update');
        if (!locked) return false;
        if ((locked.digest_upto_seq ?? null) !== input.expectedUptoSeq) return false;

        const [boundary] = await tx
          .select({ id: messages.id, content: messages.content })
          .from(messages)
          .where(and(eq(messages.session_id, sessionId), eq(messages.seq, input.uptoSeq)))
          .limit(1);
        if (!boundary || boundary.id !== input.boundary.id || boundary.content !== input.boundary.content) {
          return false;
        }

        const updated = await tx
          .update(sessions)
          .set({ digest: input.digest, digest_upto_seq: input.uptoSeq, digest_updated_at: nowIso() })
          .where(
            and(
              eq(sessions.id, sessionId),
              input.expectedUptoSeq == null
                ? sql`${sessions.digest_upto_seq} IS NULL`
                : eq(sessions.digest_upto_seq, input.expectedUptoSeq),
            ),
          )
          .returning({ id: sessions.id });
        return updated.length > 0;
      });
    },

    /**
     * Full-text search inside one conversation's messages (the model's way
     * back to details the digest folded away). Matches jieba-segmented query
     * terms; messages containing every term come first, then messages
     * containing some of the longer ones. Authorization is the caller's job.
     */
    async searchConversation(sessionId: string, query: string, limit = 10): Promise<MessageSearchHit[]> {
      const { all, recall } = messageSearchTerms(query);
      if (all.length === 0) return [];
      const base = and(eq(messages.session_id, sessionId), sql`${messages.role} IN ('user', 'assistant')`);
      const select = (terms: string[], op: 'and' | 'or', excludeIds: string[], take: number) =>
        db
          .select({
            session_id: messages.session_id,
            message_id: messages.id,
            seq: messages.seq,
            role: messages.role,
            content: messages.content,
            created_at: messages.created_at,
            matched_terms: matchedTermCount(all),
          })
          .from(messages)
          .where(
            and(
              base,
              contentTermConditions(terms, op),
              ...(excludeIds.length > 0 ? [notInArray(messages.id, excludeIds)] : []),
            ),
          )
          .orderBy(desc(matchedTermCount(all)), desc(messages.seq))
          .limit(take);

      const hits = await select(all, 'and', [], limit);
      if (hits.length < limit && all.length > 1) {
        hits.push(
          ...(await select(
            recall,
            'or',
            hits.map((h) => h.message_id),
            limit - hits.length,
          )),
        );
      }
      return hits.map(({ content, ...hit }) => ({
        ...hit,
        matched_terms: Number(hit.matched_terms),
        snippet: buildSnippet(content, query, { window: 300 }),
      }));
    },

    /**
     * Content search across ONE user's own conversations — the same owner
     * scope as `searchByTitle`, so it reveals nothing title search would not.
     * Returns the best-matching message per session, best sessions first.
     */
    async searchMessages(
      userId: string,
      query: string,
      opts: MessageSearchOpts = {},
    ): Promise<SessionMessageSearchHit[]> {
      const { all, recall } = messageSearchTerms(query);
      if (all.length === 0) return [];
      const limit = opts.limit ?? 10;
      const run = async (terms: string[], op: 'and' | 'or', excludeSessionIds: string[], take: number) => {
        const rows = await db.execute<{
          session_id: string;
          message_id: string;
          seq: number;
          role: string;
          content: string;
          created_at: string | Date;
          matched_terms: number;
          title: string | null;
          profile_id: string;
          channel: string;
          session_updated_at: string | Date;
        }>(sql`
          SELECT * FROM (
            SELECT DISTINCT ON (${messages.session_id})
                   ${messages.session_id} AS session_id,
                   ${messages.id} AS message_id,
                   ${messages.seq} AS seq,
                   ${messages.role} AS role,
                   ${messages.content} AS content,
                   ${messages.created_at} AS created_at,
                   ${matchedTermCount(all)} AS matched_terms,
                   ${sessions.title} AS title,
                   ${sessions.profile_id} AS profile_id,
                   ${sessions.channel} AS channel,
                   ${sessions.updated_at} AS session_updated_at
            FROM ${messages}
            JOIN ${sessions} ON ${sessions.id} = ${messages.session_id}
            WHERE ${sessions.user_id} = ${userId}
              AND ${sessions.status} <> 'eval'
              ${opts.channel ? sql`AND ${sessions.channel} = ${opts.channel}` : sql``}
              ${
                excludeSessionIds.length > 0
                  ? sql`AND ${messages.session_id} NOT IN (${sql.join(
                      excludeSessionIds.map((id) => sql`${id}`),
                      sql`, `,
                    )})`
                  : sql``
              }
              AND ${messages.role} IN ('user', 'assistant')
              AND ${contentTermConditions(terms, op)}
            ORDER BY ${messages.session_id}, ${matchedTermCount(all)} DESC, ${messages.seq} DESC
          ) best
          ORDER BY best.matched_terms DESC, best.session_updated_at DESC
          LIMIT ${take}
        `);
        return [...rows];
      };

      const hits = await run(all, 'and', [], limit);
      if (hits.length < limit && all.length > 1) {
        hits.push(
          ...(await run(
            recall,
            'or',
            hits.map((h) => h.session_id),
            limit - hits.length,
          )),
        );
      }
      return hits.map((hit) => ({
        session_id: hit.session_id,
        message_id: hit.message_id,
        seq: Number(hit.seq),
        role: hit.role,
        snippet: buildSnippet(hit.content, query, { window: 300 }),
        // Raw rows come back from the driver as Date; keep the ISO-string contract.
        created_at: isoString(hit.created_at),
        matched_terms: Number(hit.matched_terms),
        title: hit.title,
        profile_id: hit.profile_id,
        channel: hit.channel,
        session_updated_at: isoString(hit.session_updated_at),
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
     * Images do not get a `files` row — they live on the flat public-read
     * `/api/upload/:id` path because `<img src>` cannot send a bearer token — so
     * "is this image part of this conversation" has no handle table to ask. The
     * transcript is the record: a user upload lands in `parts.images`, and a
     * generated one lands in `parts.pipeline` as the tool's output URL.
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
            position(${imageId} in coalesce(parts -> 'images', '[]'::jsonb)::text) > 0
            OR position(${imageId} in coalesce(parts -> 'pipeline', '[]'::jsonb)::text) > 0
            OR position(${imageId} in coalesce(content, '')) > 0
          )
        LIMIT 1
      `);
      return rows.length > 0;
    },

    /**
     * Every failed tool call recorded in `messages.parts.pipeline` since `sinceIso`.
     *
     * Feeds the friction miner: agents stumble far more often than anyone
     * reports, and the pipeline column already holds the evidence. Read-only and
     * capped — this is a signal source, not an audit ledger.
     *
     */
    async scanToolErrors(sinceIso: string, limit = 2000): Promise<ToolErrorSample[]> {
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
             LATERAL jsonb_array_elements(m.parts -> 'pipeline') AS elem
        WHERE m.role = 'assistant'
          AND jsonb_typeof(m.parts -> 'pipeline') = 'array'
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
             LATERAL jsonb_array_elements(m.parts -> 'pipeline') AS elem
        WHERE m.role = 'assistant'
          AND jsonb_typeof(m.parts -> 'pipeline') = 'array'
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

    /**
     * Title search over ONE user's own conversations (eval rows never). Pass
     * `channel` to pin one channel, or `excludeChannels` to drop some — the
     * global search drops only retired `workflow` transcripts, so automation
     * runs (`task`), bot and mobile threads are all found.
     */
    async searchByTitle(
      userId: string,
      query: string,
      limit = 10,
      opts: { channel?: string; excludeChannels?: string[] } = {},
    ): Promise<SessionRow[]> {
      const pattern = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      const conditions = [
        eq(sessions.user_id, userId),
        ne(sessions.status, 'eval'),
        sql`${sessions.title} ILIKE ${pattern}`,
      ];
      if (opts.channel) conditions.push(eq(sessions.channel, opts.channel));
      if (opts.excludeChannels?.length) conditions.push(notInArray(sessions.channel, opts.excludeChannels));
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
