/**
 * Session History tool — search and read user's past conversation sessions.
 *
 * Allows the agent to recall past conversations for context continuity.
 * Strictly scoped to the current user's own sessions.
 */

import { tool } from 'ai';
import { defineTool, type ToolMeta } from './define.js';
import { z } from 'zod';
import type { DatabaseProvider } from '@greenhouse/db';

const sessionHistorySchema = z.object({
  action: z.enum(['search', 'get']).describe('Action: "search" to find sessions, "get" to read messages'),
  query: z.string().optional().describe('Search keyword for session titles (action=search)'),
  session_id: z.string().optional().describe('Session ID to read messages from (action=get)'),
  limit: z.number().min(1).max(20).default(10).describe('Max results for search (default: 10)'),
});

type SessionHistoryInput = z.infer<typeof sessionHistorySchema>;

export interface SessionHistoryContext {
  userId: string;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'session_history',
  name: 'Session History',
  brief: "Search and read user's past conversation sessions",
  description: `Search the current user's conversation history across sessions.

Actions:
- search: Search past sessions by keyword (matches title). Omit query to list recent sessions. Returns: id, title, profile, created_at.
- get: Read messages from a specific session by session_id. Returns the last 20 messages.

This tool only accesses the current user's own sessions. Use it when:
- User references a previous conversation ("上次我们讨论的...", "之前那个方案")
- User wants to find or continue a past topic
- You need historical context about what was discussed before`,
  category: 'team',
  is_global: true,
  icon: 'History',
  sort_order: 19,
  surface: { proxy: 'read', mcp: true },
};

export function createSessionHistoryTool(db: DatabaseProvider, ctx: SessionHistoryContext) {
  return tool({
    description: meta.description,
    inputSchema: sessionHistorySchema,
    execute: async (input: SessionHistoryInput) => {
      const { action, query, session_id, limit } = input;

      if (action === 'search') {
        if (!query) {
          // No query — return recent sessions
          const sessions = await db.sessions.list({
            userId: ctx.userId,
            channel: 'web',
            limit,
          });
          return {
            found: sessions.length,
            sessions: sessions.map((s) => ({
              id: s.id,
              title: s.title || '(untitled)',
              profile_id: s.profile_id,
              created_at: s.created_at,
              updated_at: s.updated_at,
            })),
          };
        }

        // Search by title
        const sessions = await db.sessions.searchByTitle(ctx.userId, query, limit);
        return {
          found: sessions.length,
          query,
          sessions: sessions.map((s) => ({
            id: s.id,
            title: s.title || '(untitled)',
            profile_id: s.profile_id,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })),
        };
      }

      if (action === 'get') {
        if (!session_id) {
          return { error: 'session_id is required for action=get' };
        }

        // Verify session belongs to user
        const session = await db.sessions.getById(session_id);
        if (!session) {
          return { error: 'Session not found' };
        }
        if (session.user_id !== ctx.userId) {
          return { error: 'Access denied — you can only read your own sessions' };
        }

        // Get messages (limit to last 20 to avoid huge context)
        const allMessages = await db.sessions.buildChatMessages(session_id);
        const messages = allMessages.slice(-20);

        return {
          session_id: session.id,
          title: session.title || '(untitled)',
          profile_id: session.profile_id,
          created_at: session.created_at,
          total_messages: allMessages.length,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content,
          })),
        };
      }

      return { error: `Unknown action: ${action}` };
    },
  });
}

export const sessionHistoryTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'internal' },
  create: (ctx) => createSessionHistoryTool(ctx.db, { userId: ctx.userId }),
});
