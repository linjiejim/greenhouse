/**
 * Take-over (AGNT-19): the Agent asks its member to act on its computer's screen, the turn
 * waits, the computer stays awake for it, and handing the computer back wakes the Agent.
 */

import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentComputers, getDb, messages, runs } from '@greenhouse/db';
import { lastUserText, scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';
import { fake, fakeSandboxEnv } from './fake-sandbox.js';

async function setup(scripts: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(scripts);
  const app = createTestApp(fakeSandboxEnv(), { languageModel: model.languageModel });
  const lin = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
  const send = async (content: string) => {
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content },
    });
    await app.services.engine.idle();
    return sent.body;
  };
  return { ...app, model, lin, main, send };
}

describe('taking over the computer', () => {
  it('raises a card the turn waits on, and handing back wakes the Agent with the note', async () => {
    const { call, member, services, model, lin, main, send } = await setup([
      toolCall('request_takeover', { reason: 'Pass the human check on example.com' }),
      text('Thanks, carrying on.'),
    ]);
    const sent = await send('book the table');
    expect(model.tools[0]).toEqual(expect.arrayContaining(['computer', 'request_takeover']));
    const [run] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(run!.status).toBe('waiting');
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    expect(card).toMatchObject({
      kind: 'takeover',
      subject: 'computer_takeover',
      status: 'pending',
      title: 'Greeny 需要你接管电脑',
      conversation_id: main.id,
      payload: { reason: 'Pass the human check on example.com' },
    });

    // A take-over is handed back, never approved, declined or answered.
    for (const decision of ['approve', 'reject']) {
      const refused = await call('POST', `/api/requests/${card.id}/${decision}`, { token: lin.token, body: {} });
      expect(refused.body.error.code).toBe('wrong_decision');
    }
    const chen = await member();
    expect((await call('POST', `/api/requests/${card.id}/handback`, { token: chen.token, body: {} })).status).toBe(404);

    const handed = await call('POST', `/api/requests/${card.id}/handback`, {
      token: lin.token,
      body: { note: 'Passed it; the form is filled in.' },
    });
    expect(handed.body).toMatchObject({ status: 'handed_back', result: { note: 'Passed it; the form is filled in.' } });
    await services.engine.idle();
    const transcript = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, main.id))
      .orderBy(asc(messages.seq));
    expect(transcript.map((row) => [row.role, row.content])).toEqual(
      expect.arrayContaining([
        ['event', '已交还电脑'],
        ['assistant', 'Thanks, carrying on.'],
      ]),
    );
    const woken = lastUserText(model.prompts[1]);
    expect(woken).toContain('handed your computer back and says: Passed it; the form is filled in.');
    expect(woken).toContain('Pass the human check on example.com');
    const [closed] = await getDb().select().from(runs).where(eq(runs.id, sent.run_id));
    expect(closed!.status).toBe('succeeded');

    // Once.
    const again = await call('POST', `/api/requests/${card.id}/handback`, { token: lin.token, body: {} });
    expect(again.body.error.code).toBe('request_settled');
  });

  it('only takes a take-over or a sign-in card', async () => {
    const { call, lin, send } = await setup([toolCall('ask_user', { question: 'Which day?' }), text('ok')]);
    await send('plan it');
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    const refused = await call('POST', `/api/requests/${card.id}/handback`, { token: lin.token, body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('wrong_decision');
  });

  it('keeps the computer awake while its take-over card waits', async () => {
    const { call, services, lin, send } = await setup([
      toolCall('request_takeover', { reason: 'Sign in to the bank' }),
      text('Done.'),
    ]);
    await call('POST', '/api/agents/main/computer/start', { token: lin.token });
    await send('pay the invoice');
    const card = (await call('GET', '/api/requests', { token: lin.token })).body.items[0];
    const idle = () =>
      getDb()
        .update(agentComputers)
        .set({ lastActiveAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
        .where(eq(agentComputers.ownerId, lin.id));
    await idle();
    await services.computers.stopIdle();
    expect([...fake.computers.values()]).toEqual(['running']);

    await call('POST', `/api/requests/${card.id}/handback`, { token: lin.token, body: {} });
    await services.engine.idle();
    await idle();
    await services.computers.stopIdle();
    expect([...fake.computers.values()]).toEqual(['stopped']);
    const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.ownerId, lin.id));
    expect(row).toMatchObject({ state: 'stopped', stateReason: 'idle' });
  });
});
