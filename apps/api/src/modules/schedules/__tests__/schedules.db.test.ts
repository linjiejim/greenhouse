import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, messages, runs, schedules } from '@greenhouse/db';
import { scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';
import { nextFiring } from '../service.js';

describe('nextFiring', () => {
  it('computes the next time in the zone and refuses what would not work', () => {
    expect(nextFiring('0 9 * * 1', 'Asia/Shanghai', new Date('2026-10-13T00:00:00Z')).toISOString()).toBe(
      '2026-10-19T01:00:00.000Z',
    );
    expect(() => nextFiring('*/5 * * * *', 'UTC')).toThrow('every 15 minutes');
    expect(() => nextFiring('0 0 9 * * 1', 'UTC')).toThrow('five fields');
    expect(() => nextFiring('0 9 * * 1', 'Nowhere/Zone')).toThrow('does not work');
  });
});

describe('schedules', () => {
  it('fire a background run on time and report into the Agent thread', async () => {
    const model = scriptedModel([text('Weekly check done: nothing overdue.')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const created = await app.call('POST', '/api/schedules', {
      token: lin.token,
      body: { agent_id: 'main', name: 'Weekly check', brief: 'Check what is overdue.', cron: '0 9 * * 1' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'active', timezone: 'Asia/Shanghai', run_count: 0 });
    expect(Date.parse(created.body.next_run_at)).toBeGreaterThan(Date.now());

    // Nothing is due yet; then time passes.
    expect(await app.services.schedules.tick()).toBe(0);
    const later = new Date(Date.parse(created.body.next_run_at) + 1000);
    expect(await app.services.schedules.tick(later)).toBe(1);
    expect(await app.services.schedules.tick(later)).toBe(0);
    await app.services.engine.idle();

    const [row] = await getDb().select().from(schedules).where(eq(schedules.id, created.body.id));
    expect(row).toMatchObject({ runCount: 1, lastStatus: 'succeeded' });
    expect(Date.parse(row!.nextRunAt!)).toBeGreaterThan(later.getTime());
    const [run] = await getDb().select().from(runs).where(eq(runs.id, row!.lastRunId!));
    expect(run).toMatchObject({
      source: 'schedule',
      sourceId: created.body.id,
      status: 'succeeded',
      title: 'Weekly check',
    });
    const main = (await app.call('GET', '/api/conversations?kind=main', { token: lin.token })).body.items[0];
    const [report] = await getDb().select().from(messages).where(eq(messages.runId, run!.id));
    expect(report).toMatchObject({ conversationId: main.id, content: 'Weekly check done: nothing overdue.' });
  });

  it('pause, resume, run now, edit and delete, for the owner only', async () => {
    const model = scriptedModel([text('ok')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const chen = await app.member();
    const writer = await app.call('POST', '/api/agents', { token: lin.token, body: { template_key: 'writer' } });
    const created = await app.call('POST', '/api/schedules', {
      token: lin.token,
      body: {
        agent_id: writer.body.id,
        name: 'Digest',
        brief: 'Summarise the week.',
        cron: '30 17 * * 5',
        timezone: 'Europe/Berlin',
      },
    });
    const id = created.body.id;
    expect((await app.call('GET', `/api/schedules/${id}`, { token: chen.token })).status).toBe(404);
    expect(
      (
        await app.call('POST', '/api/schedules', {
          token: chen.token,
          body: { agent_id: writer.body.id, name: 'x', brief: 'y', cron: '0 9 * * 1' },
        })
      ).status,
    ).toBe(404);

    const paused = await app.call('POST', `/api/schedules/${id}/pause`, { token: lin.token });
    expect(paused.body).toMatchObject({ status: 'paused', next_run_at: null });
    const resumed = await app.call('POST', `/api/schedules/${id}/resume`, { token: lin.token });
    expect(resumed.body.status).toBe('active');
    const edited = await app.call('PATCH', `/api/schedules/${id}`, { token: lin.token, body: { cron: '0 8 * * 1' } });
    expect(edited.body.cron).toBe('0 8 * * 1');
    expect(
      (await app.call('PATCH', `/api/schedules/${id}`, { token: lin.token, body: { cron: '* * * * *' } })).status,
    ).toBe(400);

    const ran = await app.call('POST', `/api/schedules/${id}/run-now`, { token: lin.token });
    expect(ran.body).toMatchObject({ run_count: 1 });
    await app.services.engine.idle();
    expect(
      (await app.call('GET', `/api/schedules?agent=${writer.body.id}`, { token: lin.token })).body.items,
    ).toHaveLength(1);
    // The writer's report lands in the writer's own thread.
    const threads = await app.call('GET', '/api/conversations?kind=direct', { token: lin.token });
    expect(threads.body.items).toEqual([expect.objectContaining({ agent_id: writer.body.id })]);

    expect((await app.call('DELETE', `/api/schedules/${id}`, { token: lin.token })).status).toBe(204);
    expect((await app.call('GET', '/api/schedules', { token: lin.token })).body.items).toEqual([]);
  });

  it('lets an Agent set up a schedule once the member approves', async () => {
    const model = scriptedModel([
      toolCall('schedule_mutation', {
        action: 'create',
        name: 'Monday plan',
        brief: 'Plan my week.',
        cron: '0 8 * * 1',
      }),
      text('Done.'),
    ]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'plan every Monday' },
    });
    await app.services.engine.idle();
    expect((await app.call('GET', '/api/schedules', { token: lin.token })).body.items).toEqual([]);
    const card = (await app.call('GET', '/api/requests', { token: lin.token })).body.items[0];
    expect(card.title).toBe('Greeny 请你批准：新建定时「Monday plan」');
    await app.call('POST', `/api/requests/${card.id}/approve`, { token: lin.token });
    await app.services.engine.idle();
    expect((await app.call('GET', '/api/schedules', { token: lin.token })).body.items).toEqual([
      expect.objectContaining({ name: 'Monday plan', cron: '0 8 * * 1' }),
    ]);
  });
});
