/**
 * Decisions are carried out each on its own: an approved write that takes long never holds up
 * the member's other decisions.
 */

import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDb, messages, requests } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { defineTool } from '../tools/define.js';
import { gate, scriptedModel, text, toolCall } from './model.js';

describe('decisions', () => {
  it('are carried out each on its own: a slow approved write holds up no other', async () => {
    const slow = gate();
    const ran: string[] = [];
    const tools = [
      defineTool({
        name: 'slow_write',
        description: 'Write something that takes a while.',
        input: z.object({}),
        risk: 'write',
        async execute() {
          await slow.promise;
          ran.push('slow');
          return { written: true };
        },
      }),
      defineTool({
        name: 'quick_write',
        description: 'Write something at once.',
        input: z.object({}),
        risk: 'write',
        async execute() {
          ran.push('quick');
          return { written: true };
        },
      }),
    ];
    const model = scriptedModel([toolCall('slow_write', {}), toolCall('quick_write', {}, 'call_2'), text('Done.')]);
    const app = createTestApp({}, { languageModel: model.languageModel, tools });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const say = async (content: string) => {
      const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
        token: lin.token,
        body: { content },
      });
      await app.services.engine.idle();
      return (await getDb().select().from(requests).where(eq(requests.runId, sent.body.run_id)))[0]!;
    };
    const slowCard = await say('write the slow thing');
    const quickCard = await say('and the quick one');
    const lines = async () =>
      (
        await getDb()
          .select({ content: messages.content })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, main.id),
              sql`${messages.event}->>'request_id' in (${slowCard.id}, ${quickCard.id})`,
            ),
          )
      ).map((row) => row.content);

    await app.call('POST', `/api/requests/${slowCard.id}/approve`, { token: lin.token });
    await app.call('POST', `/api/requests/${quickCard.id}/approve`, { token: lin.token });
    // The quick write is carried out while the slow one still runs.
    await expect.poll(lines, { timeout: 5000 }).toEqual(['已批准：quick_write']);
    expect(ran).toEqual(['quick']);

    slow.open();
    await app.services.engine.idle();
    expect(ran).toEqual(['quick', 'slow']);
    expect((await lines()).sort()).toEqual(['已批准：quick_write', '已批准：slow_write']);
  });
});
