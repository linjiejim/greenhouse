/**
 * Knowledge-base comment service — document-level comments (soft-deleted).
 *
 * Read access follows the doc (enforced in the route via resolveKbAccess);
 * this service is pure data. Comments never enter FTS / knowledge_query /
 * /search (spec D10).
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { kbComments } from '../schema/index.js';
import type { KbCommentRow } from '../schema/knowledge-base.js';

export function createKbCommentService(db: Db) {
  const service = {
    /** Live (non-deleted) comments for a doc, oldest first. */
    async list(docId: number): Promise<KbCommentRow[]> {
      return db
        .select()
        .from(kbComments)
        .where(and(eq(kbComments.doc_id, docId), isNull(kbComments.deleted_at)))
        .orderBy(asc(kbComments.created_at));
    },

    async getById(id: number): Promise<KbCommentRow | undefined> {
      const rows = await db.select().from(kbComments).where(eq(kbComments.id, id)).limit(1);
      return rows[0];
    },

    async create(docId: number, authorUserId: string, content: string): Promise<KbCommentRow> {
      const now = nowIso();
      const [row] = await db
        .insert(kbComments)
        .values({ doc_id: docId, author_user_id: authorUserId, content, created_at: now })
        .returning();
      return row!;
    },

    /** Soft-delete. Returns false for an unknown or already-deleted comment. */
    async softDelete(id: number): Promise<boolean> {
      const rows = await db
        .update(kbComments)
        .set({ deleted_at: nowIso() })
        .where(and(eq(kbComments.id, id), isNull(kbComments.deleted_at)))
        .returning({ id: kbComments.id });
      return rows.length > 0;
    },

    /** Distinct author ids of live comments on a doc (notification participants). */
    async commenterIds(docId: number): Promise<string[]> {
      const rows = await db
        .selectDistinct({ author: kbComments.author_user_id })
        .from(kbComments)
        .where(and(eq(kbComments.doc_id, docId), isNull(kbComments.deleted_at)));
      return rows.map((r) => r.author);
    },

    async count(docId: number): Promise<number> {
      const rows = await db
        .select({ cnt: sql<number>`COUNT(*)` })
        .from(kbComments)
        .where(and(eq(kbComments.doc_id, docId), isNull(kbComments.deleted_at)));
      return Number(rows[0]?.cnt ?? 0);
    },
  };
  return service;
}

export type KbCommentService = ReturnType<typeof createKbCommentService>;
