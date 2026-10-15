import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { baseAutomations, baseAutomationRuns, getDb, jobs, runs, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { gate, scriptedModel, text } from '../../../engine/__tests__/model.js';
import { tableEventChain } from '../event-context.js';
import type { AutomationInput } from '@greenhouse/contract';

async function setup(fetch?: typeof globalThis.fetch, env: Record<string, string> = {}) {
  const scripts: Parameters<typeof scriptedModel>[0] = [text('Checked the record.')];
  const model = scriptedModel(scripts);
  const app = createTestApp(
    { AGENT_EVENT_MERGE_MS: '0', ...env },
    { languageModel: model.languageModel, ...(fetch ? { fetch } : {}) },
  );
  const owner = await app.member();
  const other = await app.member();
  const base = await app.services.tables.create(owner.id, { name: 'Rules' });
  const table = base.tables[0]!;
  const title = table.fields[0]!;
  const main = (await app.services.agents.load(owner.id, 'main')).agent;
  const create = (
    trigger: AutomationInput['trigger'],
    config: AutomationInput['config'] = { actions: [{ type: 'notify', members: [owner.id], title: 'Record changed' }] },
  ) => app.services.automations.create(owner.id, base.id, { name: trigger, table_id: table.id, trigger, config });
  const history = (id: string) => app.services.automations.history(owner.id, id, { limit: 100 });
  return { ...app, scripts, model, owner, other, base, table, title, main, create, history };
}

describe('table automations', () => {
  it('queues creation and field-limited updates atomically, notifies once and records matched transitions', async () => {
    const app = await setup();
    const created = await app.create('record_created');
    const changed = await app.create('record_updated', {
      fields: [app.title.id],
      actions: [{ type: 'notify', members: [app.owner.id], title: 'Changed' }],
    });
    const matched = await app.create('record_matched', {
      filter: { mode: 'and', clauses: [{ field: app.title.id, op: 'eq', value: 'Ready' }] },
      actions: [{ type: 'notify', members: [app.owner.id], title: 'Matched' }],
    });
    const record = await app.services.tables.records.create(app.owner.id, app.table.id, { [app.title.id]: 'Draft' });
    expect((await app.history(created.id)).items).toHaveLength(1);
    expect((await app.history(changed.id)).items).toHaveLength(0);
    await app.services.tables.records.update(app.owner.id, record.record.id, 1, { [app.title.id]: 'Ready' });
    await app.services.tables.records.update(app.owner.id, record.record.id, 2, { [app.title.id]: 'Ready' });
    expect((await app.history(matched.id)).items).toHaveLength(1);
    await app.services.tables.worker.drain();
    expect((await app.history(created.id)).items[0]!.status).toBe('succeeded');
    expect((await app.history(changed.id)).items).toHaveLength(1);
    const notifications = await app.services.notifications.list(app.owner.id, { unread: 'false', limit: 100 });
    expect(notifications.items.filter((n) => n.kind === 'automation')).toHaveLength(3);
    await app.services.tables.worker.drain();
    expect(
      (await app.services.notifications.list(app.owner.id, { unread: 'false', limit: 100 })).items.filter(
        (n) => n.kind === 'automation',
      ),
    ).toHaveLength(3);
  });

  it('fires schedules, date values once, and explicit buttons; editing a rule suppresses its queued version', async () => {
    const app = await setup();
    const date = await app.services.tables.createField(app.owner.id, app.table.id, { name: 'Due', type: 'date' });
    const scheduled = await app.create('schedule', {
      interval_minutes: 1,
      actions: [{ type: 'notify', members: [app.owner.id], title: 'Scheduled' }],
    });
    const reached = await app.create('date_reached', {
      date_field_id: date.id,
      actions: [{ type: 'notify', members: [app.owner.id], title: 'Due' }],
    });
    await app.services.tables.records.create(app.owner.id, app.table.id, { [date.id]: '2020-01-01' });
    await getDb()
      .update(baseAutomations)
      .set({ nextFireAt: sql`now() - interval '1 day'` })
      .where(eq(baseAutomations.id, scheduled.id));
    await app.services.tables.worker.drain();
    await app.services.tables.worker.drain();
    expect((await app.history(scheduled.id)).items).toHaveLength(1);
    expect((await app.history(reached.id)).items).toHaveLength(1);
    const button = await app.create('button');
    await app.services.automations.button(app.owner.id, button.id);
    await app.services.automations.update(app.owner.id, button.id, {
      ...button,
      revision: button.revision,
      status: 'paused',
    });
    await app.services.tables.worker.drain();
    expect((await app.history(button.id)).items[0]!).toMatchObject({ status: 'suppressed', error: 'rule_changed' });
  });

  it('refuses untrusted webhook addresses and signs public deliveries without exposing the key', async () => {
    const sent: Array<{ body: string; headers: Headers }> = [];
    const app = await setup((async (_url, init) => {
      sent.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response('', { status: 200 });
    }) as typeof fetch);
    for (const url of [
      'http://example.com',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/',
      'https://localhost/',
    ]) {
      await expect(app.create('record_created', { actions: [{ type: 'webhook', url }] })).rejects.toMatchObject({
        code: 'automation_webhook_invalid',
      });
    }
    const initial = await app.create('record_created');
    const rule = await app.services.automations.update(app.owner.id, initial.id, {
      ...initial,
      revision: initial.revision,
      config: { actions: [{ type: 'webhook', url: 'https://example.com/hooks' }] },
    });
    expect(rule.webhook_secret).toBeTruthy();
    expect((await app.services.automations.list(app.owner.id, app.base.id, { limit: 20 })).items[0]).not.toHaveProperty(
      'webhook_secret',
    );
    await app.services.tables.records.create(app.owner.id, app.table.id, { [app.title.id]: 'Send' });
    await app.services.tables.worker.drain();
    expect(sent).toHaveLength(1);
    const time = sent[0]!.headers.get('x-greenhouse-timestamp')!;
    expect(sent[0]!.headers.get('x-greenhouse-signature')).toBe(
      `v1=${createHmac('sha256', rule.webhook_secret!).update(`${time}.${sent[0]!.body}`).digest('hex')}`,
    );
    await app.services.tables.worker.drain();
    expect(sent).toHaveLength(1);
  });

  it('delivers Agent events as table background runs with no tools and prevents recursive sources', async () => {
    const app = await setup();
    const rule = await app.create('record_created', {
      actions: [{ type: 'agent', agent_id: app.main.id, brief: 'Review this record' }],
    });
    await app.services.tables.records.create(app.owner.id, app.table.id, { [app.title.id]: 'Review' });
    await app.services.tables.worker.drain();
    await app.services.engine.sweep();
    await app.services.engine.background.idle();
    const [run] = await getDb().select().from(runs).where(eq(runs.sourceId, rule.id));
    expect(run).toMatchObject({ kind: 'background', source: 'automation', ownerId: app.owner.id, status: 'succeeded' });
    expect(app.model.tools[0]).toEqual([]);
    await tableEventChain.run([`automation:${rule.id}`], () =>
      app.services.tables.records.create(app.owner.id, app.table.id, { [app.title.id]: 'Again' }),
    );
    expect((await app.history(rule.id)).items.at(-1)!.status).toBe('suppressed');
  });

  it('keeps Agent history queued while events merge, then running until the Agent finishes', async () => {
    const app = await setup(undefined, { AGENT_EVENT_MERGE_MS: '120000' });
    const waiting = gate();
    app.scripts.splice(0, app.scripts.length, { parts: text('Finished.'), gate: waiting.promise });
    const rule = await app.create('button', { actions: [{ type: 'agent', agent_id: app.main.id, brief: 'Review' }] });
    await app.services.automations.button(app.owner.id, rule.id);
    await app.services.tables.worker.drain();
    const before = (await app.history(rule.id)).items[0]!;
    expect(before).toMatchObject({
      status: 'queued',
      run_id: null,
      started_at: null,
      finished_at: null,
      steps: [{ index: 0, status: 'queued' }],
    });
    await getDb().execute(sql`UPDATE conversation_inbox SET ready_at = now() WHERE consumed_at IS NULL`);
    await app.services.engine.sweep();
    await app.services.engine.background.sweep();
    await expect.poll(() => app.model.calls()).toBe(1);
    const active = (await app.history(rule.id)).items[0]!;
    expect(active).toMatchObject({ status: 'running', finished_at: null, steps: [{ index: 0, status: 'running' }] });
    expect(active.run_id).toBeTruthy();
    waiting.open();
    await app.services.engine.background.idle();
    expect((await app.history(rule.id)).items[0]!).toMatchObject({
      status: 'succeeded',
      steps: [{ status: 'succeeded' }],
    });
  });

  it('rechecks the execution member and recipients instead of granting permissions with a rule', async () => {
    const app = await setup();
    const response = await app.call('POST', `/api/tables/bases/${app.base.id}/automations`, {
      token: app.other.token,
      body: {
        name: 'Stolen',
        table_id: app.table.id,
        trigger: 'record_created',
        config: { actions: [{ type: 'notify', members: [app.other.id], title: 'Leak' }] },
      },
    });
    expect(response.status).toBe(404);
    const rule = await app.create('record_created');
    await app.services.tables.records.create(app.owner.id, app.table.id, {});
    await app.services.tables.archive(app.owner.id, app.base.id);
    await app.services.tables.worker.drain();
    expect(
      (await getDb().select().from(baseAutomationRuns).where(eq(baseAutomationRuns.automationId, rule.id)))[0]!.status,
    ).toBe('failed');
    expect((await getDb().select().from(jobs).where(eq(jobs.kind, 'base_automation')))[0]!.status).toBe('succeeded');
  });
});

it('applies the wake cap to automation runs and confines granted reads to the source base', async () => {
  const app = await setup(undefined, { AGENT_EVENT_WAKES_PER_DAY: '1' });
  const otherBase = await app.services.tables.create(app.owner.id, { name: 'Elsewhere' });
  const other = await app.services.tables.records.create(app.owner.id, otherBase.tables[0]!.id, {});
  const { toolCall } = await import('../../../engine/__tests__/model.js');
  app.scripts.splice(
    0,
    app.scripts.length,
    toolCall('table_query', { action: 'read', record_id: other.record.id }),
    text('Cannot read outside this base.'),
  );
  const rule = await app.create('record_created', {
    actions: [{ type: 'agent', agent_id: app.main.id, brief: 'Review', tools: 'same_base_read' }],
  });
  await app.services.tables.records.create(app.owner.id, app.table.id, {});
  await app.services.tables.records.create(app.owner.id, app.table.id, {});
  await app.services.tables.worker.drain();
  await app.services.engine.sweep();
  await app.services.engine.background.idle();
  const history = await app.history(rule.id);
  expect(history.items.map((r) => r.status).sort()).toEqual(['succeeded', 'suppressed']);
  expect(app.model.tools[0]).toEqual(['table_query']);
  const [step] = await getDb().select().from(runSteps).where(eq(runSteps.toolName, 'table_query'));
  expect(step!.status).toBe('failed');
  expect(step!.error!.message).toContain('source base');
});

it('does not replay a webhook after its sender dies and suppresses a chain beyond three levels', async () => {
  const app = await setup();
  const rule = await app.create('record_created');
  await app.services.tables.records.create(app.owner.id, app.table.id, {});
  const first = (await app.history(rule.id)).items[0]!;
  await getDb()
    .update(baseAutomationRuns)
    .set({ status: 'running', steps: [{ index: 0, status: 'sending' }] })
    .where(eq(baseAutomationRuns.id, first.id));
  await app.services.tables.worker.drain();
  expect((await app.history(rule.id)).items[0]!.status).toBe('uncertain');
  await tableEventChain.run(['source:1', 'source:2', 'source:3'], () =>
    app.services.tables.records.create(app.owner.id, app.table.id, {}),
  );
  expect((await app.history(rule.id)).items.at(-1)!.status).toBe('suppressed');
});
