/**
 * User memory service — durable, user-scoped memories (PostgreSQL).
 *
 * Writes are add-only: the agent already sees the index when it decides to
 * remember something, so it updates instead of duplicating. Whatever slips
 * through is merged by the weekly consolidation pass, which marks the loser
 * `superseded` rather than deleting it. The only hard delete is the user's own
 * from the settings page.
 */

import { eq, and, or, desc, asc, sql, inArray, lt, isNull, ilike, ne } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userMemories } from '../schema/index.js';
import type { UserMemoryRow, UserMemoryCategory, UserMemoryStatus, UserMemorySource } from '../schema/user-memory.js';

export interface UserMemoryInput {
  user_id: string;
  category: UserMemoryCategory;
  title: string;
  content: string;
  pinned?: boolean;
  source?: UserMemorySource;
  source_session_id?: string;
}

export interface UserMemoryUpdateInput {
  category?: UserMemoryCategory;
  title?: string;
  content?: string;
  pinned?: boolean;
}

export interface UserMemoryListOpts {
  status?: UserMemoryStatus | UserMemoryStatus[];
  limit?: number;
}

/** Memories unused for this long drop out of the injected index (still searchable). */
export const MEMORY_DORMANT_AFTER_DAYS = 90;

/** "Last touched" for ordering/decay — a memory never recalled falls back to when it was written. */
const lastTouched = sql`coalesce(${userMemories.last_used_at}, ${userMemories.created_at})`;

export function createUserMemoryService(db: Db) {
  const service = {
    /** Add a memory. Add-only by design — no write-time dedup verdict. */
    async create(input: UserMemoryInput): Promise<UserMemoryRow> {
      const now = nowIso();
      const rows = await db
        .insert(userMemories)
        .values({
          user_id: input.user_id,
          category: input.category,
          title: input.title,
          content: input.content,
          status: 'active',
          pinned: input.pinned ?? false,
          source: input.source ?? 'agent',
          source_session_id: input.source_session_id ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    /** List a user's memories, newest-used first. Defaults to every status. */
    async listByUser(userId: string, opts: UserMemoryListOpts = {}): Promise<UserMemoryRow[]> {
      const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : undefined;
      const where = statuses
        ? and(eq(userMemories.user_id, userId), inArray(userMemories.status, statuses))
        : eq(userMemories.user_id, userId);

      const q = db.select().from(userMemories).where(where).orderBy(desc(userMemories.pinned), desc(lastTouched));
      return opts.limit ? await q.limit(opts.limit) : await q;
    },

    /**
     * Rows eligible for the injected index: active (or pinned) memories,
     * pinned first, then most recently used.
     */
    async listForIndex(userId: string, limit = 100): Promise<UserMemoryRow[]> {
      return await db
        .select()
        .from(userMemories)
        .where(and(eq(userMemories.user_id, userId), eq(userMemories.status, 'active')))
        .orderBy(desc(userMemories.pinned), desc(lastTouched))
        .limit(limit);
    },

    /** Keyword search over title + content. Dormant/archived included on request. */
    async search(
      userId: string,
      query: string,
      opts: { includeInactive?: boolean; limit?: number } = {},
    ): Promise<UserMemoryRow[]> {
      const term = `%${query.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
      const statusFilter = opts.includeInactive
        ? ne(userMemories.status, 'superseded')
        : eq(userMemories.status, 'active');

      return await db
        .select()
        .from(userMemories)
        .where(
          and(
            eq(userMemories.user_id, userId),
            statusFilter,
            or(ilike(userMemories.title, term), ilike(userMemories.content, term)),
          ),
        )
        .orderBy(desc(userMemories.pinned), desc(lastTouched))
        .limit(opts.limit ?? 20);
    },

    async getById(id: number): Promise<UserMemoryRow | undefined> {
      const rows = await db.select().from(userMemories).where(eq(userMemories.id, id));
      return rows[0];
    },

    /** Fetch by id, scoped to an owner — the ownership check for API/tool paths. */
    async getOwned(id: number, userId: string): Promise<UserMemoryRow | undefined> {
      const rows = await db
        .select()
        .from(userMemories)
        .where(and(eq(userMemories.id, id), eq(userMemories.user_id, userId)));
      return rows[0];
    },

    async update(id: number, userId: string, updates: UserMemoryUpdateInput): Promise<UserMemoryRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.category !== undefined) set.category = updates.category;
      if (updates.title !== undefined) set.title = updates.title;
      if (updates.content !== undefined) set.content = updates.content;
      if (updates.pinned !== undefined) set.pinned = updates.pinned;

      const rows = await db
        .update(userMemories)
        .set(set)
        .where(and(eq(userMemories.id, id), eq(userMemories.user_id, userId)))
        .returning();
      return rows[0];
    },

    /**
     * Mark real use: refresh last_used_at and wake dormant rows. Prompt injection
     * must NOT call this — only an actual recall/update counts as a use.
     */
    async touch(ids: number[], userId: string): Promise<void> {
      if (ids.length === 0) return;
      const now = nowIso();
      await db
        .update(userMemories)
        .set({
          last_used_at: now,
          status: sql`case when ${userMemories.status} = 'dormant' then 'active' else ${userMemories.status} end`,
          updated_at: now,
        })
        .where(and(inArray(userMemories.id, ids), eq(userMemories.user_id, userId)));
    },

    /** Move a memory along the lifecycle (archive, supersede, restore). */
    async setStatus(
      id: number,
      userId: string,
      status: UserMemoryStatus,
      supersededBy?: number,
    ): Promise<UserMemoryRow | undefined> {
      if (status === 'superseded' && supersededBy !== undefined) {
        const replacement = await service.getOwned(supersededBy, userId);
        if (!replacement) return undefined;
      }
      const rows = await db
        .update(userMemories)
        .set({
          status,
          superseded_by: status === 'superseded' ? (supersededBy ?? null) : null,
          updated_at: nowIso(),
        })
        .where(and(eq(userMemories.id, id), eq(userMemories.user_id, userId)))
        .returning();
      return rows[0];
    },

    /** Hard delete — only ever driven by the owner from the settings page. */
    async delete(id: number, userId: string): Promise<boolean> {
      const rows = await db
        .delete(userMemories)
        .where(and(eq(userMemories.id, id), eq(userMemories.user_id, userId)))
        .returning();
      return rows.length > 0;
    },

    async countByUser(userId: string, status?: UserMemoryStatus): Promise<number> {
      const where = status
        ? and(eq(userMemories.user_id, userId), eq(userMemories.status, status))
        : eq(userMemories.user_id, userId);
      const rows = await db
        .select({ count: sql<string>`count(*)` })
        .from(userMemories)
        .where(where);
      return Number(rows[0]?.count ?? 0);
    },

    /** Users whose active-memory count is worth a consolidation pass. */
    async listUsersForConsolidation(minActive: number): Promise<Array<{ user_id: string; count: number }>> {
      const rows = await db
        .select({ user_id: userMemories.user_id, count: sql<string>`count(*)` })
        .from(userMemories)
        .where(eq(userMemories.status, 'active'))
        .groupBy(userMemories.user_id)
        .having(sql`count(*) >= ${minActive}`);
      return rows.map((r) => ({ user_id: r.user_id, count: Number(r.count) }));
    },

    /**
     * Decay pass: active, unpinned memories untouched for `days` go dormant.
     * Returns how many were demoted.
     */
    async demoteStale(days = MEMORY_DORMANT_AFTER_DAYS): Promise<number> {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const rows = await db
        .update(userMemories)
        .set({ status: 'dormant', updated_at: nowIso() })
        .where(
          and(
            eq(userMemories.status, 'active'),
            eq(userMemories.pinned, false),
            or(
              and(isNull(userMemories.last_used_at), lt(userMemories.created_at, cutoff)),
              lt(userMemories.last_used_at, cutoff),
            ),
          ),
        )
        .returning({ id: userMemories.id });
      return rows.length;
    },

    /** Oldest-first ordering helper for admin/debug listings. */
    async listAllByUserAsc(userId: string): Promise<UserMemoryRow[]> {
      return await db
        .select()
        .from(userMemories)
        .where(eq(userMemories.user_id, userId))
        .orderBy(asc(userMemories.created_at));
    },
  };
  return service;
}

export type UserMemoryService = ReturnType<typeof createUserMemoryService>;
