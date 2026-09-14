/**
 * Knowledge access resolution — single source of truth for who can do what to a
 * knowledge_base doc, shared by the HTTP route and the agent tools so the two
 * paths can never diverge (a past divergence was a cross-user leak).
 *
 * Model:
 * - team docs (visibility='team')  → collaborative: every internal user reads + writes.
 * - private docs (visibility='private') → owner has full control; others get the
 *   role granted to them directly OR via a group (editor > reader); nobody else.
 */

import type { DatabaseProvider, KnowledgeDocRow, KnowledgeShareRole } from '@greenhouse/db';

export type KbAccess = 'owner' | 'editor' | 'reader' | null;

export async function resolveKbAccess(
  db: DatabaseProvider,
  doc: Pick<KnowledgeDocRow, 'id' | 'visibility' | 'owner_user_id'>,
  userId: string,
): Promise<KbAccess> {
  if (doc.owner_user_id === userId) return 'owner';
  if (doc.visibility === 'team') return 'editor'; // team docs are collaborative
  if (doc.visibility === 'private') {
    const role: KnowledgeShareRole | null = await db.knowledgeShares.effectiveRole(doc.id, userId);
    return role; // 'editor' | 'reader' | null
  }
  return null;
}

/** Read the doc (any non-null role). */
export const canRead = (access: KbAccess): boolean => access !== null;

/** Edit / restore / AI-rewrite / enrich. */
export const canWrite = (access: KbAccess): boolean => access === 'owner' || access === 'editor';

/** Archive (soft-delete). Private docs: owner only; team docs stay collaborative. */
export const canArchive = (access: KbAccess, doc: Pick<KnowledgeDocRow, 'visibility'>): boolean =>
  access === 'owner' || doc.visibility === 'team';

/** Manage sharing + change visibility — owner only (only meaningful for private docs). */
export const canManageSharing = (access: KbAccess): boolean => access === 'owner';
