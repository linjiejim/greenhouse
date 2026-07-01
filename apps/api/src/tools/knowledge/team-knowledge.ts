/**
 * Team Knowledge tool — search and read internal team knowledge documents.
 *
 * Combines the previous search_team_knowledge + get_team_knowledge tools into
 * one internal-only domain tool with action="search" | "get".
 *
 * Thin wrapper over the shared scoped-knowledge factory (knowledge-tool-base.ts);
 * the only team-specific configuration is the visibility='team' boundary.
 */

import { defineTool, type ToolMeta } from '../define.js';
import { createScopedKnowledgeTool } from './knowledge-tool-base.js';
import type { DatabaseProvider } from '@greenhouse/db';

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'team_knowledge',
  name: 'Team Knowledge',
  brief: 'Search and read internal team knowledge-base documents, SOPs, notes, and project docs',
  description: `Unified internal team knowledge-base tool.
Actions:
- search: Search internal team knowledge-base documents. Covers SOPs, team notes, architecture, deployment, development guides, API references, and team conventions. Use English or Chinese keywords. Results include title, summary, and content snippets.
- get: Read the full Markdown content of an internal team knowledge document by doc_id. Use this after search finds a relevant result.
This tool is internal-only and must never be exposed to public/external users.`,
  category: 'team',
  is_global: true,
  icon: 'Library',
  group: 'knowledge',
  surface: { proxy: 'read', mcp: true },
};

export function createTeamKnowledgeTool(db: DatabaseProvider) {
  return createScopedKnowledgeTool(db, {
    description: meta.description,
    search: { visibility: 'team' },
    canRead: (doc) => doc.visibility === 'team',
  });
}

export const teamKnowledgeTool = defineTool({ meta, kind: 'static', create: (ctx) => createTeamKnowledgeTool(ctx.db) });
