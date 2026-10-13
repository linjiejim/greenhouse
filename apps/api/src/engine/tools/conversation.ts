import { and, desc, eq, ilike, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, messages } from '@greenhouse/db';
import { defineTool } from './define.js';

const SNIPPET = 300;

function snippet(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || text.length <= SNIPPET) return text.slice(0, SNIPPET);
  const start = Math.max(0, at - SNIPPET / 3);
  return `${start ? '…' : ''}${text.slice(start, start + SNIPPET)}…`;
}

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
    async execute(args, ctx) {
      if (!ctx.conversation) return { results: [] };
      const pattern = `%${args.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await getDb()
        .select({ seq: messages.seq, role: messages.role, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, ctx.conversation.id),
            inArray(messages.role, ['user', 'assistant']),
            ilike(messages.content, pattern),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(args.limit);
      return {
        results: rows.map((row) => ({
          seq: row.seq,
          role: row.role,
          text: snippet(row.content, args.query),
          created_at: row.createdAt,
        })),
      };
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '翻看了之前的对话' : 'Looked back in the conversation'),
  });
}
