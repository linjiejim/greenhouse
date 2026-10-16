import { interpolate } from '@greenhouse/utils/i18n';
import { z } from 'zod';
import { computerAvailable } from './computer.js';
import { defineTool } from './define.js';

/**
 * The Agent asks its member to take over its computer's screen, for what a person must do there:
 * a human check, or a sign-in or payment the Agent must not do itself. A take-over card waits,
 * the computer stays awake meanwhile, and handing the computer back wakes the Agent.
 */
export function requestTakeoverTool() {
  return defineTool({
    name: 'request_takeover',
    description:
      "Ask the member to take over your computer's screen when a person must act there: a human check (CAPTCHA), or a sign-in, payment or confirmation you must not do yourself. Say in `reason` what they should do. Never try to solve or get around a human check yourself. Your turn ends; you are woken when they hand the computer back.",
    input: z.object({ reason: z.string().min(1).max(500) }),
    risk: 'read',
    surfaces: ['turn'],
    publicAgent: true,
    available: computerAvailable,
    async execute(args, ctx) {
      const request = await ctx.raise({
        kind: 'takeover',
        subject: 'computer_takeover',
        title:
          ctx.locale === 'zh'
            ? interpolate('zh', '{name} 需要你接管电脑', { name: ctx.agent.name })
            : `${ctx.agent.name} needs you at its computer`,
        payload: { reason: args.reason },
        waits: true,
      });
      return {
        status: 'requested',
        request_id: request.id,
        note: 'The member sees your request. End your turn now; you are woken when they hand the computer back.',
      };
    },
    async decide(request, ctx) {
      const zh = ctx.locale === 'zh';
      const reason = String(request.payload.reason ?? '');
      if (request.status === 'handed_back') {
        const note = typeof request.result?.note === 'string' ? request.result.note : '';
        return {
          line: zh ? '已交还电脑' : 'Computer handed back',
          note: `The member handed your computer back${note ? ` and says: ${note}` : ''}. You had asked them to: ${reason}. Check where things stand on the computer before you go on.`,
        };
      }
      return { line: zh ? '接管请求已过期' : 'Take-over request expired', note: null };
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '请你接管电脑' : 'Asked you to take over the computer'),
  });
}
