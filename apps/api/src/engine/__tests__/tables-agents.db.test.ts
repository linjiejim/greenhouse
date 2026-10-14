import { and, eq } from 'drizzle-orm';
import { getDb, runSteps } from '@greenhouse/db';
import { expect, it } from 'vitest';
import { createTestApp } from '../../testing.js';
import { scriptedModel, text, toolCall } from './model.js';

it('discovers bases, queries filters, aggregates and cites records with the asker’s rights', async () => {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const member = await app.member();
  const base = await app.services.tables.create(member.id, { name: 'Work' });
  const table = base.tables[0]!;
  const field = table.fields[0]!;
  await app.services.tables.records.create(member.id, table.id, { [field.id]: 'Visible' });
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  scripts.push(
    toolCall('table_query', { action: 'bases' }),
    toolCall('table_query', {
      action: 'list',
      table_id: table.id,
      filter: { mode: 'and', clauses: [{ field: field.id, op: 'eq', value: 'Visible' }] },
    }),
    text('Found the record.'),
  );
  await app.call('POST', `/api/conversations/${main.id}/messages`, {
    token: member.token,
    body: { content: 'Find my work' },
  });
  await app.services.engine.idle();
  const result = await app.call('GET', `/api/conversations/${main.id}/messages`, { token: member.token });
  expect(result.body.items.at(-1).citations).toEqual([expect.objectContaining({ kind: 'record', title: 'Visible' })]);
});

async function workspace(config: Record<string, string> = {}) {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp(config, { languageModel: model.languageModel });
  const member = await app.member();
  const other = await app.member();
  const base = await app.services.tables.create(member.id, { name: 'Work' });
  const table = base.tables[0]!;
  const field = table.fields[0]!;
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  const send = async () => {
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: member.token,
      body: { content: 'Work on the record' },
    });
    await app.services.engine.idle();
    return sent.body.run_id as string;
  };
  return { ...app, member, other, base, table, field, main, scripts, model, send };
}

it('stores a long handoff field result privately and keeps the field write undoable', async () => {
  const app = await workspace({
    STORAGE_PROVIDER: 'local',
    STORAGE_ROOT: `${process.cwd()}/node_modules/.cache/tool-output-tests`,
  });
  const notes = await app.services.tables.createField(app.member.id, app.table.id, {
    name: 'Notes',
    type: 'long_text',
  });
  const source = await app.services.tables.records.create(app.member.id, app.table.id, {
    [app.field.id]: 'Source',
  });
  const report = 'Long result. '.repeat(700);
  app.scripts.push(text(report));
  const run = await app.services.recordAgents.handoff(app.member.id, source.record.id, {
    agent_id: app.main.agent_id,
    brief: 'Review this',
    output_field_id: notes.id,
  });
  await app.services.engine.background.idle();
  const detail = await app.services.runs.get(app.member.id, run.run_id);
  expect(detail.status).toBe('succeeded');
  const step = detail.steps.find((step) => step.tool === 'table_mutation')!;
  const output = step.output as { file: { id: string }; length: number };
  expect(output.length).toBeGreaterThan(8000);
  expect((await app.services.files.get(app.member.id, output.file.id)).purpose).toBe('tool_output');
  await expect(app.services.files.get(app.other.id, output.file.id)).rejects.toMatchObject({ status: 404 });
  expect((await app.services.tables.records.get(app.member.id, source.record.id)).record.values[notes.id]).toBe(report);
  await app.services.engine.undoWrite(app.member.id, step.id);
  expect((await app.services.tables.records.get(app.member.id, source.record.id)).record.values).toEqual(
    source.record.values,
  );
});

it('hands off a record to its member’s Agent, returns a tiered comment and keeps the member as owner', async () => {
  const app = await workspace();
  const record = await app.services.tables.records.create(app.member.id, app.table.id, { [app.field.id]: 'Source' });
  app.scripts.push(text('Reviewed source.'));
  const run = await app.services.recordAgents.handoff(app.member.id, record.record.id, {
    agent_id: app.main.agent_id,
    brief: 'Review this',
  });
  await app.services.engine.background.idle();
  const detail = await app.services.runs.get(app.member.id, run.run_id);
  expect(detail).toMatchObject({ source: 'record', status: 'succeeded' });
  const activity = await app.services.tables.records.activity(app.member.id, record.record.id, { limit: 20 });
  expect(JSON.stringify(activity)).toContain('Reviewed source.');
  const receipt = detail.steps.find((step) => step.tool === 'table_mutation')!;
  await app.services.engine.undoWrite(app.member.id, receipt.id);
  expect(
    JSON.stringify(await app.services.tables.records.activity(app.member.id, record.record.id, { limit: 20 })),
  ).not.toContain('Reviewed source.');
  await app.services.tables.share(app.member.id, app.base.id, {
    items: [{ type: 'member', id: app.other.id, role: 'editor' }],
  });
  app.scripts.push(text('Shared review.'));
  const shared = await app.services.recordAgents.handoff(app.member.id, record.record.id, {
    agent_id: app.main.agent_id,
    brief: 'Review again',
  });
  await app.services.engine.background.idle();
  expect((await app.services.runs.get(app.member.id, shared.run_id)).status).toBe('waiting');
  const cards = await app.call('GET', '/api/requests', { token: app.member.token });
  const card = cards.body.items.find((c: { run_id: string }) => c.run_id === shared.run_id);
  expect(card.payload.tier).toBe('tier2');
  await app.call('POST', `/api/requests/${card.id}/approve`, { token: app.member.token });
  await app.services.engine.idle();
  await app.services.engine.background.idle();
  expect(
    JSON.stringify(await app.services.tables.records.activity(app.member.id, record.record.id, { limit: 20 })),
  ).toContain('Shared review.');
  await expect(
    app.services.recordAgents.handoff(app.other.id, record.record.id, { agent_id: app.main.agent_id, brief: 'Steal' }),
  ).rejects.toMatchObject({ status: 404 });
});

it('requires confirmation for schema plans and tier 3 for permanent deletion', async () => {
  const app = await workspace();
  app.scripts.push(
    toolCall('table_schema_plan', {
      name: 'Planned',
      tables: [{ name: 'Tasks', fields: [{ name: 'Notes', type: 'long_text' }] }],
    }),
    text('Confirmed.'),
  );
  await app.send();
  expect((await app.services.tables.list(app.member.id, { archived: false })).items).toHaveLength(1);
  const cards = await app.call('GET', '/api/requests', { token: app.member.token });
  await app.call('POST', `/api/requests/${cards.body.items[0].id}/approve`, { token: app.member.token });
  await app.services.engine.idle();
  expect((await app.services.tables.list(app.member.id, { archived: false })).items).toHaveLength(2);
  const record = await app.services.tables.records.create(app.member.id, app.table.id, {});
  await app.services.tables.records.remove(app.member.id, record.record.id);
  app.scripts.push(
    toolCall('table_mutation', { action: 'purge', table_id: app.table.id, record_id: record.record.id }),
    text('Deleted.'),
  );
  await app.send();
  const pending = await app.call('GET', '/api/requests', { token: app.member.token });
  expect(pending.body.items[0].payload.tier).toBe('tier3');
  expect(
    (
      await app.call('POST', `/api/requests/${pending.body.items[0].id}/approve`, {
        token: app.member.token,
        body: { standing: true },
      })
    ).body.error.code,
  ).toBe('standing_not_allowed');
  await app.call('POST', `/api/requests/${pending.body.items[0].id}/approve`, { token: app.member.token });
  await app.services.engine.idle();
  expect((await app.services.tables.trash(app.member.id, app.base.id, { limit: 20 })).items).toHaveLength(0);
});

it('preserves a later member edit when an approved handoff result has an old revision', async () => {
  const app = await workspace();
  const source = await app.services.tables.records.create(app.member.id, app.table.id, { [app.field.id]: 'Original' });
  await app.services.tables.share(app.member.id, app.base.id, {
    items: [{ type: 'member', id: app.other.id, role: 'editor' }],
  });
  app.scripts.push(text('Agent result.'));
  const started = await app.services.recordAgents.handoff(app.member.id, source.record.id, {
    agent_id: app.main.agent_id,
    brief: 'Review',
    output_field_id: app.field.id,
  });
  await app.services.engine.background.idle();
  const cards = await app.call('GET', '/api/requests', { token: app.member.token });
  await app.services.tables.records.update(app.member.id, source.record.id, 1, { [app.field.id]: 'Later member edit' });
  await app.call('POST', `/api/requests/${cards.body.items[0].id}/approve`, { token: app.member.token });
  await app.services.engine.idle();
  await app.services.engine.background.idle();
  expect((await app.services.tables.records.get(app.member.id, source.record.id)).record.values[app.field.id]).toBe(
    'Later member edit',
  );
  expect((await app.services.runs.get(app.member.id, started.run_id)).status).toBe('failed');
  expect((await app.call('GET', '/api/requests', { token: app.member.token })).body.items).toHaveLength(0);
});

it('applies custom row and column roles to Agent reads, counts and writes', async () => {
  const app = await workspace();
  const secret = await app.services.tables.createField(app.member.id, app.table.id, { name: 'Secret', type: 'number' });
  const shown = await app.services.tables.records.create(app.member.id, app.table.id, {
    [app.field.id]: 'Shown',
    [secret.id]: 42,
  });
  await app.services.tables.records.create(app.member.id, app.table.id, { [app.field.id]: 'Hidden', [secret.id]: 99 });
  const role = await app.call('POST', `/api/tables/bases/${app.base.id}/roles`, {
    token: app.member.token,
    body: {
      name: 'Reader',
      rules: {
        tables: {
          [app.table.id]: {
            access: 'read',
            hidden_fields: [secret.id],
            rows: { mode: 'and', clauses: [{ field: app.field.id, op: 'eq', value: 'Shown' }] },
          },
        },
      },
    },
  });
  await app.services.tables.share(app.member.id, app.base.id, {
    items: [{ type: 'member', id: app.other.id, role: 'custom', custom_role_id: role.body.id }],
  });
  const thread = (await app.call('GET', '/api/conversations', { token: app.other.token })).body.items[0];
  app.scripts.push(
    toolCall('table_query', { action: 'list', table_id: app.table.id }),
    toolCall('table_query', {
      action: 'aggregate',
      card: { id: 'count', kind: 'number', title: 'Count', table_id: app.table.id, measure: { aggregate: 'count' } },
    }),
    toolCall('table_mutation', {
      action: 'update',
      table_id: app.table.id,
      record_id: shown.record.id,
      revision: 1,
      values: { [secret.id]: 0 },
    }),
    text('Read only.'),
  );
  const sent = await app.call('POST', `/api/conversations/${thread.id}/messages`, {
    token: app.other.token,
    body: { content: 'Read records and count' },
  });
  await app.services.engine.idle();
  const [read] = await getDb()
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.toolName, 'table_query')))
    .orderBy(runSteps.id);
  expect((read!.output as { items: unknown[] }).items).toHaveLength(1);
  expect(JSON.stringify(read!.output)).not.toContain(secret.id);
  const querySteps = await getDb()
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.toolName, 'table_query')))
    .orderBy(runSteps.id);
  expect(querySteps[1]!.output).toMatchObject({ kind: 'number', value: 1 });
  expect((await app.services.tables.records.get(app.member.id, shown.record.id)).record.values[secret.id]).toBe(42);
});

it('rejects invented schema targets before asking a member to approve the plan', async () => {
  const app = await workspace();
  app.scripts.push(
    toolCall('table_schema_plan', {
      name: 'New',
      tables: [{ name: 'Items', fields: [] }],
      changes: [{ action: 'create_field', table_id: 'Items', input: { name: 'Notes', type: 'long_text' } }],
    }),
    text('I need to nest the new fields in the table plan.'),
  );
  await app.send();
  expect((await app.call('GET', '/api/requests', { token: app.member.token })).body.items).toHaveLength(0);
  expect((await app.services.tables.list(app.member.id, { archived: false })).items).toHaveLength(1);
});
