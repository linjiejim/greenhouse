/**
 * The tool face of a public Agent talking to someone other than its owner (spec
 * 20261011-agent-first-class P4, D35/D36). Fixed and narrow, so its effective permissions are the
 * owner's grants and nothing of the member's:
 * - `knowledge_query` over the granted knowledge folders (read-only, as the owner reads them, only
 *   inside the granted subtrees) and its own reference folder;
 * - `memory` on the (member, Agent) partition alone — no user-level memories either way;
 * - `conversation` (this conversation's shared notes, recall);
 * - `ask_user` when the deployment has it;
 * - the computer (the member's own copy, no vault) only when its owner granted it.
 * Never: team, self, background tasks, email, automations, connectors, projects, tables, sessions,
 * exports, images, the vault.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { BotRow, DatabaseProvider } from '@greenhouse/db';
import type { BotPublicationSettings } from '@greenhouse/types/bots';
import { entityUrl } from '@greenhouse/types/entity-links';
import { safeJsonParse } from '@greenhouse/utils/json';
import { canRead, resolveKbAccess } from '../../knowledge/access.js';
import { runKnowledgeAgentAction } from '../../platform/knowledge/agent-adapter.js';
import { grantedFolderIds, publicationOf, publicBotFor } from '../public.js';
import { selectTools, type ToolRegistry } from '../../agent.js';
import { createMemoryTool } from '../../tools/memory.js';
import { buildComputerTools } from '../computer/index.js';
import { createConversationTool } from '../tools/conversation.js';
import type { BotTurnContext } from './context.js';
import type { ConversationPort } from './ports.js';

const SEARCH_LIMIT = 10;
const BODY_MAX_CHARS = 12_000;

const knowledgeSchema = z.object({
  action: z.enum(['search', 'list', 'get']).describe('search {query} | list | get {id}'),
  query: z.string().max(300).optional().describe('search: what to look for.'),
  id: z.number().int().positive().optional().describe('get: the document id from search or list.'),
});

/**
 * Read as the owner through the platform guard, narrowed to current publication grants and
 * document ACLs. Recheck each execution: a turn may outlive a permission or publication change.
 */
export function createGrantedKnowledgeTool(
  db: DatabaseProvider,
  bot: Pick<BotRow, 'id' | 'user_id'>,
  requesterId: string,
): Tool {
  const link = (doc: { id: number; doc_id: string; visibility?: string | null }) =>
    // A team document opens for everyone; a private one of the owner does not — no dead link.
    doc.visibility === 'team' ? entityUrl({ kind: 'kb_doc', id: doc.id, slug: doc.doc_id }) : undefined;
  return tool({
    description:
      'The knowledge your owner shared with you (the folders granted to you, and your own reference folder). Actions: search {query} — find documents; list — what is there; get {id} — read one. Cite what you use. Nothing else in the library is visible to you.',
    inputSchema: knowledgeSchema,
    execute: async (input: z.infer<typeof knowledgeSchema>) =>
      runKnowledgeAgentAction(
        { userId: bot.user_id },
        ({ search: 'searchDocuments', list: 'listDocuments', get: 'readDocument' } as const)[input.action],
        input,
        async () => {
          const current = await publicBotFor(db, requesterId, bot.id);
          if (!current || current.user_id !== bot.user_id)
            return { error: 'This public Agent is no longer available.' };
          const allowed = new Set(await grantedFolderIds(db, current, publicationOf(current)));
          const readable = async (doc: Awaited<ReturnType<typeof db.knowledgeBase.getById>>): Promise<boolean> =>
            !!doc &&
            doc.folder_id !== null &&
            allowed.has(doc.folder_id) &&
            doc.status !== 'archived' &&
            canRead(await resolveKbAccess(db, doc, bot.user_id));
          if (allowed.size === 0) return { found: 0, results: [], note: 'No knowledge was shared with you.' };
          if (input.action === 'search') {
            const query = input.query?.trim();
            if (!query) return { error: 'search needs a query' };
            const candidates = await db.knowledgeBase.search(query, {
              readerUserId: bot.user_id,
              folderIds: [...allowed],
              status: 'published',
              limit: SEARCH_LIMIT,
            });
            const results = [];
            for (const hit of candidates) {
              if (await readable(await db.knowledgeBase.getById(hit.id))) results.push(hit);
            }
            return {
              found: results.length,
              results: results.map((r) => ({
                id: r.id,
                title: r.title,
                snippet: r.snippet,
                summary: r._summary ?? '',
              })),
            };
          }
          if (input.action === 'list') {
            const candidates = await db.knowledgeBase.list({
              readerUserId: bot.user_id,
              folderIds: [...allowed],
              status: 'published',
              limit: 50,
            });
            const docs = [];
            for (const doc of candidates) if (await readable(doc)) docs.push(doc);
            return {
              found: docs.length,
              results: docs.map((d) => ({ id: d.id, title: d.title, summary: d._summary ?? '' })),
            };
          }
          if (!input.id) return { error: 'get needs an id' };
          const doc = await db.knowledgeBase.getById(input.id);
          if (!doc || !(await readable(doc))) {
            return { error: `No document ${input.id} among what was shared with you.` };
          }
          const url = link(doc);
          return {
            id: doc.id,
            title: doc.title,
            ...(url ? { url } : {}),
            content: doc.content.length > BODY_MAX_CHARS ? `${doc.content.slice(0, BODY_MAX_CHARS)}\n…` : doc.content,
            tags: safeJsonParse(doc.tags, []),
          };
        },
        input.action === 'get' ? input.id : undefined,
      ),
  });
}

export interface PublicFaceInput {
  db: DatabaseProvider;
  ctx: BotTurnContext;
  toolRegistry: ToolRegistry;
  conversation: ConversationPort;
  settings: BotPublicationSettings;
}

export function assemblePublicAgentTools(input: PublicFaceInput): {
  tools: Record<string, Tool>;
  approvalGated: false;
} {
  const { db, ctx } = input;
  const registry: ToolRegistry = selectTools(input.toolRegistry, ['ask_user']);
  registry.knowledge_query = createGrantedKnowledgeTool(db, ctx.bot, ctx.userId);
  registry.memory = createMemoryTool(db, {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    bot: { botId: ctx.bot.id, userScopeAllowed: () => false, partitionOnly: true },
  });
  registry.conversation = createConversationTool(ctx, input.conversation);
  if (input.settings.grants.computer) Object.assign(registry, buildComputerTools(ctx));
  // Fixed order: the tool list is part of the cached prompt prefix.
  const tools: Record<string, Tool> = {};
  for (const id of Object.keys(registry).sort()) tools[id] = registry[id] as Tool;
  return { tools, approvalGated: false };
}
