/**
 * Session Query tool — read-only access to conversation sessions.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from '../define.js';

const sessionQuerySchema = z.object({
  action: z.enum(['list', 'search', 'get', 'messages', 'usage']).describe('Read-only session action.'),
  query: z.string().optional().describe('Title search query for search action.'),
  session_id: z.string().optional().describe('Session id for get/messages/usage.'),
  channel: z.string().optional().describe('Optional channel filter for list, e.g. web/api/task.'),
  limit: z.number().min(1).max(100).optional().describe('Max results/messages (default 20).'),
  offset: z.number().min(0).optional().describe('Pagination offset.'),
});

type SessionQueryInput = z.infer<typeof sessionQuerySchema>;

export interface SessionQueryContext {
  userId: string;
  userRole: string;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'session_query',
  name: 'Session Query',
  brief: 'Read conversation sessions and usage',
  description: `Read-only session query tool. Actions: list, search, get, messages, usage. Team users can read their own sessions; super users can list/read broader session data where supported.`,
  category: 'team',
  is_global: true,
  icon: 'MessagesSquare',
  group: 'sessions',
  surface: { proxy: 'read', mcp: true },
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
          const sessions = await db.sessions.searchByTitle(ctx.userId, input.query, limit);
          return {
            found: sessions.length,
            query: input.query,
            sessions: sessions.map((s) => ({
              id: s.id,
              title: s.title || '(untitled)',
              profile_id: s.profile_id,
              channel: s.channel,
              updated_at: s.updated_at,
            })),
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

export const sessionQueryTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'internal' },
  create: (ctx) => createSessionQueryTool(ctx.db, { userId: ctx.userId, userRole: ctx.userRole }),
});
