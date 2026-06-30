/**
 * Session tag service — user-defined session tag CRUD + tag↔session linking (PostgreSQL).
 */

import { eq, and, asc, inArray } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { sessionTags, sessionTagLinks } from '../schema/index.js';
import type { SessionTagRow } from '../schema/session-tag.js';

export interface SessionTagInput {
  user_id: string;
  name: string;
  color?: string;
  sort_order?: number;
}

export interface SessionTagUpdateInput {
  name?: string;
  color?: string;
  sort_order?: number;
}

export function createSessionTagService(db: Db) {
  const service = {
    async create(input: SessionTagInput): Promise<SessionTagRow> {
      const now = nowIso();
      const rows = await db
        .insert(sessionTags)
        .values({
          user_id: input.user_id,
          name: input.name,
          color: input.color ?? '#6B7280',
          sort_order: input.sort_order ?? 0,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    async listByUser(userId: string): Promise<SessionTagRow[]> {
      return await db
        .select()
        .from(sessionTags)
        .where(eq(sessionTags.user_id, userId))
        .orderBy(asc(sessionTags.sort_order), asc(sessionTags.id));
    },

    async getById(id: number): Promise<SessionTagRow | undefined> {
      const rows = await db.select().from(sessionTags).where(eq(sessionTags.id, id));
      return rows[0];
    },

    async update(id: number, updates: SessionTagUpdateInput): Promise<SessionTagRow | undefined> {
      const rows = await db
        .update(sessionTags)
        .set({ ...updates, updated_at: nowIso() })
        .where(eq(sessionTags.id, id))
        .returning();
      return rows[0];
    },

    async delete(id: number): Promise<boolean> {
      const result = await db.delete(sessionTags).where(eq(sessionTags.id, id)).returning();
      return result.length > 0;
    },

    async addTagToSession(sessionId: string, tagId: number): Promise<void> {
      await db
        .insert(sessionTagLinks)
        .values({ session_id: sessionId, tag_id: tagId, created_at: nowIso() })
        .onConflictDoNothing();
    },

    async removeTagFromSession(sessionId: string, tagId: number): Promise<void> {
      await db
        .delete(sessionTagLinks)
        .where(and(eq(sessionTagLinks.session_id, sessionId), eq(sessionTagLinks.tag_id, tagId)));
    },

    async getSessionTags(sessionId: string): Promise<SessionTagRow[]> {
      const rows = await db
        .select({
          id: sessionTags.id,
          user_id: sessionTags.user_id,
          name: sessionTags.name,
          color: sessionTags.color,
          sort_order: sessionTags.sort_order,
          created_at: sessionTags.created_at,
          updated_at: sessionTags.updated_at,
        })
        .from(sessionTagLinks)
        .innerJoin(sessionTags, eq(sessionTagLinks.tag_id, sessionTags.id))
        .where(eq(sessionTagLinks.session_id, sessionId))
        .orderBy(asc(sessionTags.sort_order));
      return rows;
    },

    async getTagsBySessionIds(sessionIds: string[]): Promise<Map<string, SessionTagRow[]>> {
      if (sessionIds.length === 0) return new Map();

      const rows = await db
        .select({
          session_id: sessionTagLinks.session_id,
          id: sessionTags.id,
          user_id: sessionTags.user_id,
          name: sessionTags.name,
          color: sessionTags.color,
          sort_order: sessionTags.sort_order,
          created_at: sessionTags.created_at,
          updated_at: sessionTags.updated_at,
        })
        .from(sessionTagLinks)
        .innerJoin(sessionTags, eq(sessionTagLinks.tag_id, sessionTags.id))
        .where(inArray(sessionTagLinks.session_id, sessionIds))
        .orderBy(asc(sessionTags.sort_order));

      const result = new Map<string, SessionTagRow[]>();
      for (const row of rows) {
        const sid = row.session_id;
        if (!result.has(sid)) result.set(sid, []);
        result.get(sid)!.push({
          id: row.id,
          user_id: row.user_id,
          name: row.name,
          color: row.color,
          sort_order: row.sort_order,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
      }
      return result;
    },

    async reorder(updates: Array<{ id: number; sort_order: number }>): Promise<void> {
      const now = nowIso();
      await Promise.all(
        updates.map((u) =>
          db.update(sessionTags).set({ sort_order: u.sort_order, updated_at: now }).where(eq(sessionTags.id, u.id)),
        ),
      );
    },
  };
  return service;
}

export type SessionTagService = ReturnType<typeof createSessionTagService>;
