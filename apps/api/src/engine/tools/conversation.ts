import { and, desc, eq, ilike, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, messages } from '@greenhouse/db';
import { containing, snippetAround } from '../../http/like.js';
import { defineTool } from './define.js';

const SNIPPET = 300;

/** Older parts of this conversation, beyond what fits in the context. */
export function conversationTool() {
  return defineTool({
    name: 'conversation_query',
    description:
      'Search earlier messages of this conversation when something said before is not in your context. Returns matching messages, newest first, with their position in the conversation.',
    input: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).default(8) }),
    risk: 'read',
    private: true,
    surfaces: ['turn'],
    // The asker's own conversation.
    publicAgent: true,
    async execute(args, ctx) {
      if (!ctx.conversation) return { results: [] };
      const rows = await getDb()
        .select({ seq: messages.seq, role: messages.role, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, ctx.conversation.id),
            inArray(messages.role, ['user', 'assistant']),
            ilike(messages.content, containing(args.query)),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(args.limit);
      return {
        results: rows.map((row) => ({
          seq: row.seq,
          role: row.role,
          text: snippetAround(row.content, args.query, SNIPPET),
          created_at: row.createdAt,
        })),
      };
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '翻看了之前的对话' : 'Looked back in the conversation'),
  });
}
