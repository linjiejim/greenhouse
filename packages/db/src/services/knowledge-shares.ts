/**
 * Knowledge share service — granular sharing of PRIVATE knowledge docs with
 * specific users (PostgreSQL). A grant's `shared_with` is a user_id.
 */

import { eq, and, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { knowledgeBaseShares } from '../schema/index.js';
import type { KnowledgeShareRole, KnowledgeShareRow } from '../schema/knowledge-base.js';

export function createKnowledgeShareService(db: Db) {
  const service = {
    /** Create or update a grant (upsert on doc_id + shared_with). */
    async grant(
      docId: number,
      sharedWith: string,
      role: KnowledgeShareRole,
      sharedBy: string,
      message?: string,
    ): Promise<void> {
      await db
        .insert(knowledgeBaseShares)
        .values({
          doc_id: docId,
          shared_with: sharedWith,
          role,
          shared_by: sharedBy,
          message: message ?? null,
          created_at: nowIso(),
        })
        .onConflictDoUpdate({
          target: [knowledgeBaseShares.doc_id, knowledgeBaseShares.shared_with],
          set: { role, shared_by: sharedBy, message: message ?? null },
        });
    },

    async revoke(docId: number, sharedWith: string): Promise<boolean> {
      const result = await db
        .delete(knowledgeBaseShares)
        .where(and(eq(knowledgeBaseShares.doc_id, docId), eq(knowledgeBaseShares.shared_with, sharedWith)))
        .returning({ id: knowledgeBaseShares.id });
      return result.length > 0;
    },

    /** All grants on a doc (for the manage-sharing panel). */
    async listForDoc(docId: number): Promise<KnowledgeShareRow[]> {
      return db
        .select()
        .from(knowledgeBaseShares)
        .where(eq(knowledgeBaseShares.doc_id, docId))
        .orderBy(desc(knowledgeBaseShares.created_at));
    },

    /** The user's role on a doc from their grant, or null when there is none. */
    async effectiveRole(docId: number, userId: string): Promise<KnowledgeShareRole | null> {
      const rows = await db
        .select({ role: knowledgeBaseShares.role })
        .from(knowledgeBaseShares)
        .where(and(eq(knowledgeBaseShares.doc_id, docId), eq(knowledgeBaseShares.shared_with, userId)))
        .limit(1);
      return rows[0]?.role ?? null;
    },

    /** Every user a doc is shared with (for live-update fan-out). */
    async userIdsWithAccess(docId: number): Promise<string[]> {
      const rows = await db
        .select({ user_id: knowledgeBaseShares.shared_with })
        .from(knowledgeBaseShares)
        .where(eq(knowledgeBaseShares.doc_id, docId));
      return rows.map((row) => String(row.user_id));
    },

    /** Distinct doc ids shared with the user. */
    async listDocIdsForUser(userId: string): Promise<number[]> {
      const rows = await db
        .selectDistinct({ doc_id: knowledgeBaseShares.doc_id })
        .from(knowledgeBaseShares)
        .where(eq(knowledgeBaseShares.shared_with, userId));
      return rows.map((r) => Number(r.doc_id));
    },
  };
  return service;
}

export type KnowledgeShareService = ReturnType<typeof createKnowledgeShareService>;
