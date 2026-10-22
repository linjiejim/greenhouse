/**
 * Session Query tool — read-only access to Greenhouse conversation sessions.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';

const sessionQuerySchema = z.object({
  action: z
    .enum(['list', 'search', 'get', 'messages', 'usage', 'conversation_search'])
    .describe('Read-only session action.'),
  query: z.string().optional().describe('Keywords for search (titles + message text) and conversation_search.'),
  session_id: z
    .string()
    .optional()
    .describe('Session id for get/messages/usage; conversation_search defaults to the current conversation.'),
  channel: z.string().optional().describe('Optional channel filter for list, e.g. web/api/task.'),
  limit: z.number().min(1).max(100).optional().describe('Max results/messages (default 20).'),
  offset: z.number().min(0).optional().describe('Pagination offset.'),
});

type SessionQueryInput = z.infer<typeof sessionQuerySchema>;

export interface SessionQueryContext {
  userId: string;
  userRole: string;
  /** The conversation the tool runs in (chat surfaces only; absent on proxy/MCP). */
  sessionId?: string | null;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'session_query',
  name: 'Session Query',
  brief: 'Read Greenhouse conversation sessions and usage',
  description: `Read-only session query tool. Actions: list (recent sessions; channel:"web" = the user's normal conversations), search (keywords in titles and message text), get, messages, usage, conversation_search (keywords inside one conversation — the current one by default — returning matching messages with their seq). Team users can read their own sessions; super users can list/read broader session data where supported.

Use it to recall past conversations when the user references one ("上次我们讨论的…", "之前那个方案") or you need historical context: search/list to find the session, then messages to read it. When this conversation's earlier part was folded into a summary, use conversation_search to recover exact wording, numbers or details.`,
  category: 'team',
  is_global: true,
  surface: { proxy: 'read', mcp: 'chat', unattendedReplaySafe: true },
  icon: 'MessagesSquare',
  sort_order: 28,
};

export function createSessionQueryTool(db: DatabaseProvider, ctx: SessionQueryContext) {
  return tool({
    description: meta.description,
    inputSchema: sessionQuerySchema,
    execute: async (input: SessionQueryInput) => {
      try {
        const limit = input.limit ?? 20;

        if (input.action === 'list') {
          const sessions = await db.sessions.list({
            userId: ctx.userRole === 'super' ? undefined : ctx.userId,
            channel: input.channel,
            limit,
            offset: input.offset,
          });
          return {
            found: sessions.length,
            sessions: sessions.map((s) => ({
              id: s.id,
              title: s.title || '(untitled)',
              profile_id: s.profile_id,
              channel: s.channel,
              status: s.status,
              user_id: ctx.userRole === 'super' ? s.user_id : undefined,
              created_at: s.created_at,
              updated_at: s.updated_at,
            })),
          };
        }

        if (input.action === 'search') {
          if (!input.query) return { error: 'query is required for action=search' };
          // Title matches first (as before), then conversations whose MESSAGES
          // match. Both lanes are scoped to the caller's own sessions only.
          const byTitle = await db.sessions.searchByTitle(ctx.userId, input.query, limit);
          const titleIds = new Set(byTitle.map((s) => s.id));
          const byContent = (await db.sessions.searchMessages(ctx.userId, input.query, { limit }))
            .filter((hit) => !titleIds.has(hit.session_id))
            .slice(0, Math.max(0, limit - byTitle.length));
          const sessions = [
            ...byTitle.map((s) => ({
              id: s.id,
              title: s.title || '(untitled)',
              profile_id: s.profile_id,
              channel: s.channel,
              updated_at: s.updated_at,
            })),
            ...byContent.map((hit) => ({
              id: hit.session_id,
              title: hit.title || '(untitled)',
              profile_id: hit.profile_id,
              channel: hit.channel,
              updated_at: hit.session_updated_at,
              match: { message_id: hit.message_id, seq: hit.seq, role: hit.role, snippet: hit.snippet },
            })),
          ];
          return { found: sessions.length, query: input.query, sessions };
        }

        if (input.action === 'conversation_search') {
          if (!input.query) return { error: 'query is required for action=conversation_search' };
          const targetId = input.session_id ?? ctx.sessionId ?? undefined;
          if (!targetId) {
            return { error: 'session_id is required for action=conversation_search outside a conversation' };
          }
          const target = await db.sessions.getById(targetId);
          if (!target) return { error: 'Session not found' };
          if (ctx.userRole !== 'super' && target.user_id !== ctx.userId) {
            return { error: 'Access denied — you can only read your own sessions' };
          }
          const matches = await db.sessions.searchConversation(target.id, input.query, Math.min(limit, 20));
          if (matches.length === 0 && (await db.sessions.getMessageCount(target.id)) === 0) {
            return { error: 'This conversation has no messages yet — there is nothing to search.' };
          }
          return {
            session_id: target.id,
            query: input.query,
            found: matches.length,
            matches: matches.map((m) => ({
              message_id: m.message_id,
              seq: m.seq,
              role: m.role,
              snippet: m.snippet,
              created_at: m.created_at,
            })),
            ...(matches.length > 0
              ? { hint: 'Read a match in full with action "messages", offset = its seq, limit = 1–3.' }
              : {}),
          };
        }

        if (!input.session_id) return { error: 'session_id is required' };
        const session = await db.sessions.getById(input.session_id);
        if (!session) return { error: 'Session not found' };
        if (ctx.userRole !== 'super' && session.user_id !== ctx.userId) {
          return { error: 'Access denied — you can only read your own sessions' };
        }

        if (input.action === 'usage') {
          return { session_id: session.id, usage: await db.sessions.getUsage(session.id) };
        }

        if (input.action === 'messages') {
          const messages = await db.sessions.getMessages(session.id, { limit, offset: input.offset });
          return {
            session_id: session.id,
            total: await db.sessions.getMessageCount(session.id),
            messages: messages.map((m) => ({
              id: m.id,
              seq: m.seq,
              role: m.role,
              content: m.content.length > 1000 ? `${m.content.slice(0, 1000)}...` : m.content,
              created_at: m.created_at,
            })),
          };
        }

        return {
          session: {
            id: session.id,
            title: session.title || '(untitled)',
            profile_id: session.profile_id,
            channel: session.channel,
            status: session.status,
            rating: session.rating,
            created_at: session.created_at,
            updated_at: session.updated_at,
          },
          message_count: await db.sessions.getMessageCount(session.id),
        };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const sessionQueryTool = defineTool({ meta, kind: 'lazy' });
