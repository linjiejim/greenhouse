/**
 * Personal Knowledge tool — search and read the current user's own personal
 * knowledge-base documents (private notes, drafts).
 *
 * Per-request tool: requires userId context (injected in tool-resolution).
 *
 * Personal docs live in the same `knowledge_base` table as team docs but with
 * visibility='private' and owner_user_id=<the creator>. This tool is strictly
 * scoped to the current user's own private docs — it can never surface another
 * user's notes or team-visible documents.
 *
 * Shares its implementation with team_knowledge via the scoped-knowledge factory
 * (knowledge-tool-base.ts); the only personal-specific config is the
 * visibility='private' + owner_user_id boundary.
 */

import { defineTool, type ToolMeta } from '../define.js';
import { createScopedKnowledgeTool } from './knowledge-tool-base.js';
import type { DatabaseProvider } from '@greenhouse/db';

export interface PersonalKnowledgeContext {
  userId: string;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'personal_knowledge',
  name: 'Personal Knowledge',
  brief: "Search and read the current user's own personal knowledge-base notes",
  description: `Search and read the current user's PERSONAL knowledge-base documents (private notes, drafts).
Actions:
- search: Find the current user's personal notes by keyword (English or Chinese). Returns title, summary, and snippets.
- get: Read the full Markdown content of one personal document by doc_id (from search results).
These documents belong only to the current user and are never shared with the team.
This tool only ever returns the current user's own private docs — it cannot access other users' notes or team knowledge.`,
  category: 'team',
  is_global: true,
  icon: 'BookOpen',
  group: 'knowledge',
};

export function createPersonalKnowledgeTool(db: DatabaseProvider, ctx: PersonalKnowledgeContext) {
  return createScopedKnowledgeTool(db, {
    description: meta.description,
    search: { visibility: 'private', ownerUserId: ctx.userId },
    canRead: (doc) => doc.visibility === 'private' && doc.owner_user_id === ctx.userId,
  });
}

export const personalKnowledgeTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'required' },
  create: (ctx) => createPersonalKnowledgeTool(ctx.db, { userId: ctx.userId }),
});
