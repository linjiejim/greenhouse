import { assertDiscriminator } from '@greenhouse/types/discriminators';
/**
 * Knowledge share service — granular sharing of PRIVATE knowledge docs with
 * specific users, stored as `shares` rows (resource_type = 'kb_document',
 * principal_type = 'user'). A grant's `shared_with` is a user id.
 */

import { eq, and, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/api/extension-kit';

import { type Db } from '@greenhouse/api/extension-kit';
import { newId } from '@greenhouse/api/extension-kit';
import { shares } from '@greenhouse/api/extension-kit';

export type KnowledgeShareRole = 'reader' | 'editor';

/** One grant on a knowledge document, in the shape the routes and web expect. */
export interface KnowledgeShareRow {
  id: string;
  doc_id: string;
  shared_with: string;
  role: KnowledgeShareRole;
  shared_by: string;
  message: string | null;
  created_at: string;
}

const KB = 'kb_document' as const;

const shareColumns = {
  id: shares.id,
  doc_id: shares.resource_id,
  shared_with: shares.principal_id,
  role: shares.role,
  shared_by: shares.created_by,
  message: shares.message,
  created_at: shares.created_at,
};

function docGrants(docId: string) {
  return and(eq(shares.resource_type, KB), eq(shares.resource_id, String(docId)), eq(shares.principal_type, 'user'));
}

function toShareRole(role: string | null | undefined): KnowledgeShareRole | null {
  if (!role) return null;
  return role === 'editor' ? 'editor' : 'reader';
}

export function createKnowledgeShareService(db: Db) {
  const service = {
    /** Create or update a grant (upsert on doc + user). */
    async grant(
      docId: string,
      sharedWith: string,
      role: KnowledgeShareRole,
      sharedBy: string,
      message?: string,
    ): Promise<void> {
      assertDiscriminator('shareResources', KB);
      const now = nowIso();
      await db
        .insert(shares)
        .values({
          id: newId('share'),
          resource_type: KB,
          resource_id: String(docId),
          principal_type: 'user',
          principal_id: sharedWith,
          role,
          message: message ?? null,
          created_by: sharedBy,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [shares.resource_type, shares.resource_id, shares.principal_type, shares.principal_id],
          set: { role, created_by: sharedBy, message: message ?? null, updated_at: now },
        });
    },

    async revoke(docId: string, sharedWith: string): Promise<boolean> {
      const result = await db
        .delete(shares)
        .where(and(docGrants(docId), eq(shares.principal_id, sharedWith)))
        .returning({ id: shares.id });
      return result.length > 0;
    },

    /** All grants on a doc (for the manage-sharing panel), newest first. */
    async listForDoc(docId: string): Promise<KnowledgeShareRow[]> {
      const rows = await db
        .select(shareColumns)
        .from(shares)
        .where(docGrants(docId))
        .orderBy(desc(shares.created_at), desc(shares.id));
      return rows.map((row) => ({
        id: row.id,
        doc_id: row.doc_id,
        shared_with: row.shared_with ?? '',
        role: toShareRole(row.role) ?? 'reader',
        shared_by: row.shared_by ?? '',
        message: row.message,
        created_at: row.created_at,
      }));
    },

    /** The user's role on a doc from their grant, or null when there is none. */
    async effectiveRole(docId: string, userId: string): Promise<KnowledgeShareRole | null> {
      const rows = await db
        .select({ role: shares.role })
        .from(shares)
        .where(and(docGrants(docId), eq(shares.principal_id, userId)))
        .limit(1);
      return toShareRole(rows[0]?.role);
    },

    /** Every user a doc is shared with (for live-update fan-out). */
    async userIdsWithAccess(docId: string): Promise<string[]> {
      const rows = await db.select({ user_id: shares.principal_id }).from(shares).where(docGrants(docId));
      return rows.flatMap((row) => (row.user_id ? [row.user_id] : []));
    },

    /** Distinct doc ids shared with the user. */
    async listDocIdsForUser(userId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ doc_id: shares.resource_id })
        .from(shares)
        .where(and(eq(shares.resource_type, KB), eq(shares.principal_type, 'user'), eq(shares.principal_id, userId)));
      return rows.map((r) => r.doc_id);
    },
  };
  return service;
}

export type KnowledgeShareService = ReturnType<typeof createKnowledgeShareService>;
