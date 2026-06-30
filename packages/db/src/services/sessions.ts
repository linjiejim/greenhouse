/**
 * Session service — conversation session & message persistence (PostgreSQL).
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql, ne, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { sessions, messages } from '../schema/index.js';
import type { SessionRow, MessageRow, MessageInput, SessionChannel } from '@greenhouse/types/session';
import type { SessionUsage } from '@greenhouse/types/api';

export interface SessionListOpts {
  status?: string;
  limit?: number;
  offset?: number;
  includeEval?: boolean;
  userId?: string; // filter sessions by owner
  channel?: string; // filter by channel: 'web' | 'api' | 'a2a' | 'task'
  taskId?: number; // filter by scheduled task (via metadata)
}

export interface PaginationOpts {
  limit?: number;
  offset?: number;
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
    ): Promise<SessionRow> {
      const now = nowIso();
      const session: SessionRow = {
        id: randomUUID(),
        title: title ?? null,
        status: 'active',
        rating: null,
        comment: null,
        feedback: null,
        profile_id: profileId ?? 'default',
        user_id: userId ?? null,
        app_id: appId ?? null,
        channel: channel ?? 'web',
        parent_session_id: parentSessionId ?? null,
        metadata: '{}',
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

    async list(opts: SessionListOpts = {}): Promise<SessionRow[]> {
      const { status, limit = 200, offset = 0, includeEval = false, userId, channel, taskId } = opts;
      const conditions = [];

      if (userId) conditions.push(eq(sessions.user_id, userId));
      if (channel) conditions.push(eq(sessions.channel, channel));
      if (taskId) conditions.push(sql`${sessions.metadata}::jsonb @> ${JSON.stringify({ task_id: taskId })}::jsonb`);
      if (status && status !== 'all') {
        conditions.push(eq(sessions.status, status));
      } else if (!includeEval) {
        conditions.push(ne(sessions.status, 'eval'));
      }

      let query = db.select().from(sessions);
      if (conditions.length > 0) {
        query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as any;
      }
      return (await (query as any).orderBy(desc(sessions.updated_at)).limit(limit).offset(offset)) as SessionRow[];
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

    async delete(id: string): Promise<void> {
      await db.delete(messages).where(eq(messages.session_id, id));
      await db.delete(sessions).where(eq(sessions.id, id));
    },

    async deleteMessagesAfterSeq(sessionId: string, seq: number): Promise<void> {
      await db.delete(messages).where(and(eq(messages.session_id, sessionId), sql`seq >= ${seq}`));
    },

    async getMessageById(id: string): Promise<MessageRow | undefined> {
      const rows = await db.select().from(messages).where(eq(messages.id, id));
      return rows[0] as MessageRow | undefined;
    },

    async updateMessageContent(id: string, content: string): Promise<void> {
      await db.update(messages).set({ content }).where(eq(messages.id, id));
    },

    async addMessage(input: MessageInput): Promise<MessageRow> {
      const now = nowIso();

      const row = {
        id: randomUUID(),
        session_id: input.session_id,
        role: input.role,
        content: input.content,
        references_: JSON.stringify(input.references ?? []),
        pipeline: JSON.stringify(input.pipeline ?? []),
        reasoning: input.reasoning ?? null,
        images: JSON.stringify(input.images ?? []),
        confidence: input.confidence ?? null,
        grounded: input.grounded != null ? (input.grounded ? 1 : 0) : null,
        input_tokens: input.input_tokens ?? null,
        output_tokens: input.output_tokens ?? null,
        cached_tokens: input.cached_tokens ?? null,
        reasoning_tokens: input.reasoning_tokens ?? null,
        duration_ms: input.duration_ms ?? null,
        created_at: now,
      };

      // seq is computed inside the INSERT (single statement) instead of a prior
      // SELECT MAX round trip — the old read-modify-write could hand two
      // concurrent writers the same seq. Note: not fully serializable without a
      // unique (session_id, seq) index; this closes the practical window.
      const inserted = await db
        .insert(messages)
        .values({
          ...row,
          seq: sql<number>`(SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE session_id = ${input.session_id})`,
        })
        .returning();
      await service.touch(input.session_id);
      return inserted[0] as MessageRow;
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

    async getMessageCount(sessionId: string): Promise<number> {
      const row = (
        await db
          .select({ cnt: sql<number>`COUNT(*)` })
          .from(messages)
          .where(eq(messages.session_id, sessionId))
      )[0];
      return Number(row?.cnt ?? 0);
    },

    async buildChatMessages(sessionId: string): Promise<Array<{ role: string; content: string; created_at?: string }>> {
      return await db
        .select({ role: messages.role, content: messages.content, created_at: messages.created_at })
        .from(messages)
        .where(and(eq(messages.session_id, sessionId), sql`role IN ('user', 'assistant')`))
        .orderBy(messages.seq);
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

    /** List sessions spawned by a given parent session (lineage). */
    async listChildren(parentSessionId: string): Promise<SessionRow[]> {
      return (await db
        .select()
        .from(sessions)
        .where(eq(sessions.parent_session_id, parentSessionId))
        .orderBy(desc(sessions.created_at))) as SessionRow[];
    },

    async searchByTitle(userId: string, query: string, limit = 10): Promise<SessionRow[]> {
      const pattern = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      return (await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.user_id, userId), ne(sessions.status, 'eval'), sql`${sessions.title} ILIKE ${pattern}`))
        .orderBy(desc(sessions.updated_at))
        .limit(limit)) as SessionRow[];
    },
  };
  return service;
}

export type SessionService = ReturnType<typeof createSessionService>;
