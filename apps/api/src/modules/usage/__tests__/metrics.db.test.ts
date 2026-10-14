import { getDb, newId, members, requests, runs, usageEvents } from '@greenhouse/db';
import { eq, sql } from 'drizzle-orm';
import { TEST_PASSWORD } from '../../../testing.js';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing.js';
import { scriptedModel, text } from '../../../engine/__tests__/model.js';

describe('weekly product metrics', () => {
  it('counts adoption once across ratings and citations, reveals only aggregates to admins', async () => {
    const model = scriptedModel([text('Private reply text')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const admin = await app.member('admin');
    const member = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
    await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Private question' },
    });
    await app.services.engine.idle();
    const reply = (
      await app.call('GET', `/api/conversations/${main.id}/messages`, { token: member.token })
    ).body.items.at(-1);
    for (let index = 0; index < 2; index++) {
      await app.call('PUT', `/api/conversations/${main.id}/messages/${reply.id}/feedback`, {
        token: member.token,
        body: { rating: 1 },
      });
      const cite = await app.call('POST', '/api/metrics/adopt', {
        token: member.token,
        body: { kind: 'citation', message_id: reply.id },
      });
      expect(cite.status).toBe(204);
    }
    expect((await app.call('GET', '/api/admin/usage/metrics', { token: member.token })).status).toBe(403);
    const agent = (await app.services.agents.load(member.id, 'main')).agent;
    await getDb()
      .insert(requests)
      .values(
        ['approved', 'rejected'].map((status, index) => ({
          id: newId('request'),
          memberId: member.id,
          kind: 'approval' as const,
          subject: 'tool_write',
          status: status as 'approved' | 'rejected',
          payload: { tier: index ? 'tier2' : 'tier3' },
          decidedAt: sql`now()`,
        })),
      );
    await getDb()
      .insert(runs)
      .values(
        ['succeeded', 'failed'].map((status) => ({
          id: newId('run'),
          ownerId: member.id,
          agentId: agent.id,
          kind: 'background' as const,
          source: 'schedule' as const,
          status: status as 'succeeded' | 'failed',
          finishedAt: sql`now()`,
        })),
      );
    await getDb()
      .insert(runs)
      .values({
        id: newId('run'),
        ownerId: member.id,
        agentId: agent.id,
        kind: 'turn',
        source: 'conversation',
        status: 'succeeded',
        input: { reason: 'event' },
        finishedAt: sql`now()`,
      });
    await getDb().insert(usageEvents).values({
      capability: 'llm',
      providerId: 'test-provider',
      source: 'env',
      memberId: member.id,
      inputTokens: 400,
      cachedTokens: 100,
    });
    const result = await app.call('GET', '/api/admin/usage/metrics?weeks=2', { token: admin.token });
    expect(result.status).toBe(200);
    expect(result.body.weeks).toHaveLength(2);
    expect(result.body.weeks[0]).toMatchObject({ adopted_outputs: 1, active_members: 1, adopted_per_active_member: 1 });
    expect(JSON.stringify(result.body)).not.toContain('Private');
    expect(JSON.stringify(result.body)).not.toContain(member.id);
    expect(
      (
        await app.call('POST', '/api/metrics/adopt', {
          token: admin.token,
          body: { kind: 'citation', message_id: reply.id },
        })
      ).status,
    ).toBe(404);
  });
  it('activates only after a first-day assignment and adoption', async () => {
    const model = scriptedModel([text('An output')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const admin = await app.member('admin');
    const member = await app.member();
    await app.call('POST', '/api/auth/login', {
      body: { email: member.email, password: TEST_PASSWORD, client: 'web' },
    });
    const main = await app.services.conversations.ensureMain(member.id);
    await app.services.engine.post(member.id, main.id, { content: 'Do the work', attachments: [], mentions: [] });
    await app.services.engine.idle();
    const reply = (await app.services.conversations.messages(member.id, main.id, { limit: 50 })).items.at(-1)!;
    await app.services.conversations.rate(member.id, main.id, reply.id, { rating: 1 });
    const result = await app.services.metrics.weekly(admin.id, 1);
    expect(result.weeks[0]).toMatchObject({ new_members: 1, activated_members: 1, activation_rate: 1 });
  });
  it('does not count an existing member’s later login as a new activation cohort', async () => {
    const app = createTestApp();
    const admin = await app.member('admin');
    const member = await app.member();
    await getDb()
      .update(members)
      .set({ lastLoginAt: sql`now() - interval '7 days'` })
      .where(eq(members.id, member.id));
    await app.call('POST', '/api/auth/login', {
      body: { email: member.email, password: TEST_PASSWORD, client: 'web' },
    });
    expect((await app.services.metrics.weekly(admin.id, 1)).weeks[0]?.new_members).toBe(0);
  });
});
