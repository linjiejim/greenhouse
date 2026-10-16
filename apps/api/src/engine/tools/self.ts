import { interpolate } from '@greenhouse/utils/i18n';
import { z } from 'zod';
import { AGENT_INSTRUCTIONS_MAX } from '@greenhouse/contract';
import type { AgentsService } from '../../modules/agents/service.js';
import { defineTool } from './define.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An Agent proposing new standing instructions for itself. A proposal has no effect: an Agent
 * that rewrote its own rules after reading a page would be a lasting injection, so only the
 * member's acceptance changes them.
 */
export function selfTool(agents: AgentsService) {
  return defineTool({
    name: 'self',
    description:
      'Propose new standing instructions for yourself after learning a lasting lesson about how to do your job. Give the complete new text and the reason. Nothing changes until the member accepts.',
    input: z.object({
      instructions: z.string().min(1).max(AGENT_INSTRUCTIONS_MAX),
      reason: z.string().min(1).max(500),
    }),
    risk: 'read',
    surfaces: ['turn'],
    async execute(args, ctx) {
      const request = await ctx.raise({
        kind: 'proposal',
        subject: 'instructions_update',
        title:
          ctx.locale === 'zh'
            ? interpolate('zh', '{name} 想修改自己的指令', { name: ctx.agent.name })
            : `${ctx.agent.name} proposes new instructions`,
        payload: { instructions: args.instructions, reason: args.reason, current: ctx.manifest.instructions },
        waits: false,
        expiresInMs: WEEK_MS,
      });
      return { status: 'proposed', request_id: request.id };
    },
    async decide(request, ctx) {
      const zh = ctx.locale === 'zh';
      if (request.status === 'approved') {
        await agents.update(ctx.memberId, ctx.agent.id, {
          instructions: String(request.payload.instructions),
          change_note: String(request.payload.reason ?? '').slice(0, 200),
        });
        // The transcript line is enough; waking the Agent would only get a thank-you.
        return { line: zh ? '已采纳新的指令' : 'New instructions accepted', note: null };
      }
      if (request.status === 'rejected')
        return { line: zh ? '没有采纳新的指令' : 'New instructions declined', note: null };
      return { line: zh ? '指令提议已过期' : 'Instructions proposal expired', note: null };
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '提议修改指令' : 'Proposed new instructions'),
  });
}
