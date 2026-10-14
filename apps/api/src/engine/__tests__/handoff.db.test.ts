import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { conversationAgents, getDb, handoffs, messages, runs } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { lastUserText, scriptedModel, systemText, text, textThenTool, toolCall } from './model.js';

describe('hand-offs', () => {
  it("bring the other Agent in, which answers next with the member's rights", async () => {
    const scripts: Parameters<typeof scriptedModel>[0] = [];
    const model = scriptedModel(scripts);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const writer = await app.call('POST', '/api/agents', { token: lin.token, body: { template_key: 'writer' } });
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    scripts.push(
      textThenTool('I handed the polishing to 卷卷.', 'handoff', {
        agent: '卷卷',
        brief: 'Polish this paragraph: hello world.',
      }),
      text('Hello, world.'),
    );
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'polish: hello world' },
    });
    await app.services.engine.idle();

    const transcript = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, main.id))
      .orderBy(asc(messages.seq));
    expect(
      transcript.slice(2).map((m) => [m.role, m.agentId === writer.body.id ? 'writer' : 'main', m.content]),
    ).toEqual([
      ['assistant', 'main', 'I handed the polishing to 卷卷.'],
      ['event', 'main', 'Greeny 把工作交给了 卷卷'],
      ['assistant', 'writer', 'Hello, world.'],
    ]);
    // The first turn stopped right after the hand-off.
    expect(model.calls()).toBe(2);
    expect(systemText(model.prompts[0])).toContain('Only a successful tool result transfers the work');
    expect(systemText(model.prompts[1])).toContain('You are **卷卷**');
    expect(lastUserText(model.prompts[1])).toContain('Greeny handed this to you');
    expect(lastUserText(model.prompts[1])).toContain('Polish this paragraph');
    const present = await getDb()
      .select()
      .from(conversationAgents)
      .where(eq(conversationAgents.conversationId, main.id));
    expect(present.map((row) => row.agentId)).toEqual([writer.body.id]);
    const [handoff] = await getDb().select().from(handoffs).where(eq(handoffs.chainKey, sent.body.run_id));
    expect(handoff).toMatchObject({
      status: 'replied',
      reply: 'Hello, world.',
      targetAgentId: writer.body.id,
      requestedBy: lin.id,
    });
    const [writerRun] = await getDb().select().from(runs).where(eq(runs.id, handoff!.runId!));
    expect(writerRun).toMatchObject({ ownerId: lin.id, agentId: writer.body.id, status: 'succeeded' });
  });

  it('refuses loops and unknown Agents', async () => {
    const scripts: Parameters<typeof scriptedModel>[0] = [];
    const model = scriptedModel(scripts);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    await app.call('POST', '/api/agents', { token: lin.token, body: { template_key: 'writer' } });
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    scripts.push(
      toolCall('handoff', { agent: 'Nobody', brief: 'x' }),
      text('No such Agent.'),
      textThenTool('Over to 卷卷.', 'handoff', { agent: '卷卷', brief: 'Write it.' }),
      // 卷卷 tries to hand back to Greeny: a circle.
      toolCall('handoff', { agent: 'main', brief: 'Your turn again.' }),
      text('I will do it myself.'),
    );
    await app.call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: 'first' } });
    await app.services.engine.idle();
    await app.call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: 'second' } });
    await app.services.engine.idle();
    const rows = await getDb().select().from(handoffs);
    expect(rows).toHaveLength(1);
    const last = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, main.id))
      .orderBy(asc(messages.seq));
    expect(last.at(-1)!.content).toBe('I will do it myself.');
  });
});
