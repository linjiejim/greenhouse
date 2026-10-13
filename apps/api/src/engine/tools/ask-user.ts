import { z } from 'zod';
import { questionFieldSchema, type QuestionField } from '@greenhouse/contract';
import { defineTool } from './define.js';

/** A question the Agent cannot go on without: a short form, and the turn waits for the answer. */
export function askUserTool() {
  return defineTool({
    name: 'ask_user',
    description:
      'Ask the member something you cannot go on without. They get a short form with your question and the fields you give (text, or a choice of options). Your turn ends; their answer comes back to you.',
    input: z.object({
      question: z.string().min(1).max(500),
      fields: z.array(questionFieldSchema).max(6).default([]),
    }),
    risk: 'read',
    surfaces: ['turn'],
    publicAgent: true,
    async execute(args, ctx) {
      const fields: QuestionField[] = args.fields.length
        ? args.fields
        : [{ key: 'answer', label: args.question, type: 'text', required: true }];
      const request = await ctx.raise({
        kind: 'question',
        subject: 'ask_user',
        title: args.question,
        payload: { question: args.question, fields },
        waits: true,
      });
      return { status: 'asked', request_id: request.id, note: 'The member sees your question. End your turn now.' };
    },
    async decide(request, ctx) {
      const question = String(request.payload.question ?? '');
      const zh = ctx.locale === 'zh';
      if (request.status === 'answered') {
        const fields = (request.payload.fields ?? []) as QuestionField[];
        const answers = (request.result?.answers ?? {}) as Record<string, string>;
        const lines = Object.entries(answers).map(
          ([key, value]) => `${fields.find((field) => field.key === key)?.label ?? key}: ${value}`,
        );
        return {
          line: zh ? `已回答：${question}` : `Answered: ${question}`,
          note: `The member answered your question "${question}":\n${lines.join('\n')}`,
        };
      }
      if (request.status === 'rejected') {
        return {
          line: zh ? `没有回答：${question}` : `Not answered: ${question}`,
          note: `The member dismissed your question "${question}". Go on without it, or ask once more only if you truly cannot.`,
        };
      }
      return { line: zh ? `问题已过期：${question}` : `Question expired: ${question}`, note: null };
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '提了一个问题' : 'Asked a question'),
  });
}
