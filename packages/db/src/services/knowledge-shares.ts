/**
 * Knowledge share service — granular sharing of PRIVATE knowledge docs with
 * specific users or groups (PostgreSQL).
 *
 * A grant's `shared_with` is either a user_id or 'group:<groupId>'. Effective
 * access for a user folds in both their direct grants and any group they belong
 * to, taking the highest role (editor > reader).
 */

import { eq, and, desc, sql } from 'drizzle-orm';
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

    /**
     * Highest effective role for a user on a doc, considering BOTH a direct
     * user grant and any group grant the user is a member of. editor > reader.
     * Returns null when the user has no grant.
     */
    async effectiveRole(docId: number, userId: string): Promise<KnowledgeShareRole | null> {
      // Match a direct user grant OR any group grant the user belongs to, then
      // pick the strongest role (editor wins over reader).
      const rows = (await db.execute(sql`
        SELECT role FROM knowledge_base_shares
        WHERE doc_id = ${docId}
          AND (
            shared_with = ${userId}
            OR shared_with IN (
              SELECT 'group:' || group_id FROM group_members WHERE user_id = ${userId}
            )
          )
        ORDER BY CASE role WHEN 'editor' THEN 0 ELSE 1 END
        LIMIT 1
      `)) as unknown as Array<{ role: KnowledgeShareRole }>;
      return rows[0]?.role ?? null;
    },

    /** Distinct doc ids shared with the user (directly or via a group). */
    async listDocIdsForUser(userId: string): Promise<number[]> {
      const rows = (await db.execute(sql`
        SELECT DISTINCT doc_id FROM knowledge_base_shares
        WHERE shared_with = ${userId}
          OR shared_with IN (
            SELECT 'group:' || group_id FROM group_members WHERE user_id = ${userId}
          )
      `)) as unknown as Array<{ doc_id: number }>;
      return rows.map((r) => Number(r.doc_id));
    },
  };
  return service;
}

export type KnowledgeShareService = ReturnType<typeof createKnowledgeShareService>;
