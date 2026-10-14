/** A real process killed by the recovery test only after a model/tool boundary committed. */
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { agentMemories, createDbClient, getDb, newId, runs, setDb } from '@greenhouse/db';
import { createTestServices } from '../../../testing.js';
import { defineTool } from '../../tools/define.js';
import { gate, scriptedModel, text, textThenTool } from '../model.js';

const [databaseUrl, memberId, conversationId, mode] = process.argv.slice(2) as [string, string, string, string?];
const interjection = mode === 'interjection';
const first = gate();
const client = createDbClient(databaseUrl);
setDb(client.db);
const model = scriptedModel([
  {
    parts: textThenTool('I checked alpha. ', 'lookup', { q: 'alpha' }),
    ...(interjection ? { gate: first.promise } : {}),
  },
  ...(interjection ? [textThenTool('With extra detail. ', 'lookup', { q: 'beta' })] : []),
  { parts: text('Never completed'), gate: gate().promise },
]);
const services = createTestServices(
  { GREENHOUSE_ROLE: 'api' },
  {
    languageModel: model.languageModel,
    tools: [
      defineTool({
        name: 'lookup',
        description: 'Look up a fact.',
        risk: 'read',
        taints: true,
        input: z.object({ q: z.string() }),
        async execute(args, ctx) {
          await getDb()
            .insert(agentMemories)
            .values({
              id: newId('memory'),
              agentId: ctx.agent.id,
              memberId: ctx.memberId,
              title: 'lookup evidence',
              content: args.q,
            });
          ctx.cite?.({ kind: 'web', url: 'https://example.test/alpha', title: 'Alpha evidence' }, 'read');
          return { fact: `${args.q} is 42` };
        },
      }),
    ],
  },
);
const sent = await services.engine.post(memberId, conversationId, {
  content: 'Find alpha.',
  mentions: [],
  attachments: [],
});
if (interjection) {
  while (model.calls() < 1) await new Promise((resolve) => setTimeout(resolve, 10));
  process.send?.({ runId: sent.run_id, phase: 'started' });
  await once(process, 'message');
  first.open();
}
while (model.calls() < (interjection ? 3 : 2)) await new Promise((resolve) => setTimeout(resolve, 10));
const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id!));
if (run?.checkpoint?.turn_step !== (interjection ? 3 : 1)) throw new Error('No completed checkpoint');
process.send?.({ runId: run.id, phase: 'checkpoint' });
