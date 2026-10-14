import { z } from 'zod';
import { MEMORY_CATEGORIES } from '@greenhouse/contract';
import type { AgentsService } from '../../modules/agents/service.js';
import { defineTool } from './define.js';

const input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('remember'),
    title: z.string().min(1).max(120).describe('One line; the only part that is shown to you in later turns.'),
    content: z.string().max(4000).default('').describe('Detail you can read back with recall.'),
    category: z.enum(MEMORY_CATEGORIES).default('fact'),
  }),
  z
    .object({
      action: z.literal('recall'),
      query: z.string().max(200).optional().describe('Words to look for; omit for a date range.'),
      from: z.iso.date().optional().describe('Inclusive UTC date, YYYY-MM-DD.'),
      to: z.iso.date().optional().describe('Inclusive UTC date, YYYY-MM-DD.'),
    })
    .refine((args) => !!args.query || !!args.from || !!args.to, { message: 'Give words or a date range.' }),
  z.object({
    action: z.literal('update'),
    id: z.string(),
    title: z.string().min(1).max(120).optional(),
    content: z.string().max(4000).optional(),
  }),
  z.object({ action: z.literal('forget'), id: z.string() }),
]);

/** Durable notes about the member and about how this Agent does its job. Private to the Agent. */
export function memoryTool(agents: AgentsService) {
  return defineTool({
    name: 'memory',
    description:
      'Your memory of this member: durable facts, preferences and lessons about how to do your job. Titles of what you remember are listed each turn; recall reads the detail. Never store secrets, passwords or task details.',
    input,
    // Notes in the Agent's own memory, which the member can review and delete at any time.
    risk: 'read',
    surfaces: ['turn', 'background'],
    // A public Agent keeps one memory per asker: it reads and writes only theirs.
    publicAgent: true,
    private: true,
    async callRisk(args, ctx) {
      if (args.action === 'recall' || ctx.surface === 'background' || ctx.tainted()) return 'read';
      return args.action === 'forget' ? 'tier3' : 'tier1';
    },
    async guard(args, ctx) {
      if (ctx.surface !== 'background' && !ctx.tainted() && (args.action === 'update' || args.action === 'forget'))
        await agents.lockMemory(ctx.memberId, ctx.agent.id, args.id);
    },
    async before(args, ctx) {
      return {
        input: { action: args.action, ...('id' in args ? { id: args.id } : {}) },
        ...(args.action === 'update' ? { previous: await agents.lockMemory(ctx.memberId, ctx.agent.id, args.id) } : {}),
      };
    },
    async undo(_args, output, before, ctx) {
      const result = output as { remembered?: string; updated?: string; updated_at: string };
      await agents.undoMemory(
        ctx.memberId,
        ctx.agent.id,
        (result.remembered ?? result.updated)!,
        result.updated_at,
        (before as { previous?: { title: string; content: string } }).previous,
      );
    },
    describe: (args, ctx) => ({
      summary: ctx.locale === 'zh' ? '彻底删除一条记忆' : 'permanently delete a memory',
      details: 'id' in args ? [{ label: ctx.locale === 'zh' ? '记忆' : 'Memory', value: args.id }] : [],
    }),
    async execute(args, ctx) {
      if (ctx.surface === 'background' && args.action !== 'recall')
        throw new Error('Background runs may only recall memories.');
      if (args.action !== 'recall' && ctx.tainted())
        return { error: 'Memories cannot be changed after reading outside content in the same turn. Ask the member.' };
      const handle = ctx.agent.id;
      if (args.action === 'remember') {
        const saved = await agents.remember(
          ctx.memberId,
          handle,
          { title: args.title, content: args.content, category: args.category, pinned: false },
          { source: 'agent', conversationId: ctx.conversation?.id },
        );
        return { remembered: saved.id, updated_at: saved.updated_at };
      }
      if (args.action === 'recall') {
        if (!args.query && !args.from && !args.to) throw new Error('Give words or a date range to recall.');
        const query = (args.query ?? '').toLowerCase();
        const all = await agents.memories(ctx.memberId, handle, 'active');
        const hits = all
          .filter(
            (memory) =>
              `${memory.title}\n${memory.content}`.toLowerCase().includes(query) &&
              (!args.from || memory.created_at.slice(0, 10) >= args.from) &&
              (!args.to || memory.created_at.slice(0, 10) <= args.to),
          )
          .slice(0, 10)
          .map((memory) => ({
            id: memory.id,
            title: memory.title,
            content: memory.content,
            category: memory.category,
          }));
        // Completion logs can summarize outside sources; reading their detail taints this turn.
        if (hits.some((memory) => memory.category === 'log')) ctx.taint();
        return { results: hits };
      }
      // Text read this turn could be steering the change; old memories stay as they are.
      if (ctx.tainted()) {
        return { error: 'Memories cannot be changed after reading outside content in the same turn. Ask the member.' };
      }
      if (args.action === 'update') {
        const saved = await agents.updateMemory(ctx.memberId, handle, args.id, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
        });
        return { updated: args.id, updated_at: saved.updated_at };
      }
      await agents.forget(ctx.memberId, handle, args.id);
      return { forgotten: args.id };
    },
    summarize: (args, _output, locale) =>
      ({
        remember: locale === 'zh' ? '记住了一件事' : 'Remembered something',
        recall: locale === 'zh' ? '回想了记忆' : 'Recalled memories',
        update: locale === 'zh' ? '更新了一条记忆' : 'Updated a memory',
        forget: locale === 'zh' ? '忘记了一条记忆' : 'Forgot a memory',
      })[args.action],
  });
}
