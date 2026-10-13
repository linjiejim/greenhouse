/**
 * A card decided before its turn has finished (a quick hand-back while the reply is still being
 * saved): the run must not be left waiting for a card that is already settled.
 */

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDb, runs } from '@greenhouse/db';
import type { Services } from '../../app.js';
import { createTestApp } from '../../testing.js';
import { defineTool } from '../tools/define.js';
import { scriptedModel, toolCall } from './model.js';

/**
 * Raises a waiting card and has it decided at once, before the turn reaches its end. `decide`
 * false settles it without telling the engine yet, so the turn's own finish is what must notice.
 */
function quickTool(services: () => Services, decide = true) {
  return defineTool({
    name: 'quick_card',
    description: 'Ask the member something they answer at once.',
    input: z.object({}),
    risk: 'read',
    async execute(_args, ctx) {
      const request = await ctx.raise({
        kind: 'takeover',
        subject: 'computer_takeover',
        title: 'Quick',
        payload: { reason: 'quick' },
        waits: true,
      });
      const settled = await services().requests.settle(ctx.memberId, request.id, {
        status: 'handed_back',
        result: { decision: 'handed_back' },
      });
      if (decide) services().engine.decide(settled);
      return { status: 'requested' };
    },
  });
}

describe('a card decided before its turn finished', () => {
  it.each([
    ['the decision closes the run', true],
    ["the turn's finish sees the card is settled", false],
  ])('%s instead of leaving it waiting', async (_name, decide) => {
    let app: ReturnType<typeof createTestApp> | null = null;
    const model = scriptedModel([toolCall('quick_card', {})]);
    app = createTestApp({}, { languageModel: model.languageModel, tools: [quickTool(() => app!.services, decide)] });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'go' },
    });
    await app.services.engine.idle();
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.body.run_id));
    expect(run!.status).toBe('succeeded');
  });
});
