import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { getDb, requests, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { scriptedModel, text, toolCall } from './model.js';
import { callTool, mcp, toolNames } from '../../modules/oauth/__tests__/flow.js';

it('reads app pages, gates shared saved actions, refuses model values and scopes MCP separately', async () => {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const owner = await app.member();
  const member = await app.member();
  const base = await app.services.tables.create(owner.id, { name: 'Work' });
  const table = base.tables[0]!;
  const field = table.fields[0]!;
  await app.services.tables.share(owner.id, base.id, { items: [{ type: 'member', id: member.id, role: 'editor' }] });
  const created = await app.services.apps.create(owner.id, { base_id: base.id, name: 'Office', description: '' });
  const draft = await app.services.apps.save(owner.id, created.app.id, {
    revision: created.revision,
    name: 'Office',
    description: '',
    spec: {
      roles: [],
      pages: [
        {
          id: 'home',
          name: 'Home',
          cards: [
            {
              id: 'add',
              kind: 'button',
              title: 'Add',
              table_id: table.id,
              action: { id: 'create', name: 'Add saved record', type: 'create', values: { [field.id]: 'Saved value' } },
            },
          ],
        },
      ],
    },
  });
  await app.services.apps.publish(owner.id, draft.app.id, {
    revision: draft.revision,
    notes: '',
    audience: [{ principal_type: 'member', principal_id: member.id, role: 'use' }],
  });
  const args = { app_id: draft.app.id, version: 1, card: 'add', action: 'create', values: {} };
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  scripts.push(
    toolCall('apps_query', { action: 'get', app_id: draft.app.id }),
    toolCall('apps_action', args),
    text('Created.'),
  );
  const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
    token: member.token,
    body: { content: 'Add a record' },
  });
  await app.services.engine.idle();
  const [card] = await getDb().select().from(requests).where(eq(requests.runId, sent.body.run_id));
  expect(card!.payload.tier).toBe('tier2');
  expect(JSON.stringify(card!.payload.details)).toContain('Saved value');
  await app.call('POST', `/api/requests/${card!.id}/approve`, { token: member.token });
  await app.services.engine.idle();
  expect((await app.services.tables.records.query(member.id, table.id, {})).items[0]!.values[field.id]).toBe(
    'Saved value',
  );
  await expect(
    app.services.apps.actionPlan(member.id, draft.app.id, { ...args, values: { [field.id]: 'Injected' } }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  const token = (
    await app.call('POST', '/api/me/tokens', {
      token: member.token,
      body: { name: 'Apps read', scopes: ['apps:read'] },
    })
  ).body.token;
  expect(await toolNames(app, token)).toEqual(['apps_query']);
  const listed = await mcp(app, token);
  const schema = listed.body.result.tools[0].inputSchema;
  expect(schema).toMatchObject({ type: 'object', properties: { action: expect.any(Object) } });
  expect(schema).not.toHaveProperty('anyOf');
  expect(schema).not.toHaveProperty('oneOf');
  expect((await callTool(app, token, 'apps_query', { action: 'get', app_id: draft.app.id })).output.app.id).toBe(
    draft.app.id,
  );

  const denied = await callTool(app, token, 'apps_action', args);
  expect(JSON.stringify(denied)).toContain('not');
  const writeToken = (
    await app.call('POST', '/api/me/tokens', {
      token: member.token,
      body: { name: 'Apps write', scopes: ['apps:write'] },
    })
  ).body.token;
  const result = await callTool(app, writeToken, 'apps_action', args);
  expect(JSON.stringify(result)).toContain('needs_you');
  const steps = await getDb().select().from(runSteps).where(eq(runSteps.toolName, 'apps_action'));
  expect(steps.filter((s) => s.status === 'pending')).toHaveLength(1);
});

it('keeps private app writes undoable through the original action', async () => {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const owner = await app.member();
  const base = await app.services.tables.create(owner.id, { name: 'Private app' });
  const table = base.tables[0]!;
  const field = table.fields[0]!;
  const created = await app.services.apps.create(owner.id, { base_id: base.id, name: 'Private', description: '' });
  const draft = await app.services.apps.save(owner.id, created.app.id, {
    revision: created.revision,
    name: 'Private',
    description: '',
    spec: {
      roles: [],
      pages: [
        {
          id: 'home',
          name: 'Home',
          cards: [
            {
              id: 'add',
              kind: 'button',
              title: 'Add',
              table_id: table.id,
              action: { id: 'create', name: 'Add', type: 'create', values: { [field.id]: 'New' } },
            },
          ],
        },
      ],
    },
  });
  await app.services.apps.publish(owner.id, draft.app.id, { revision: draft.revision, notes: '', audience: [] });
  const main = (await app.call('GET', '/api/conversations', { token: owner.token })).body.items[0];
  scripts.push(
    toolCall('apps_action', { app_id: draft.app.id, version: 1, card: 'add', action: 'create' }),
    text('Created.'),
  );
  const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
    token: owner.token,
    body: { content: 'Create' },
  });
  await app.services.engine.idle();
  const [step] = await getDb()
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.toolName, 'apps_action')));
  expect(step!.risk).toBe('tier1');
  expect((await app.call('POST', `/api/runs/steps/${step!.id}/undo`, { token: owner.token })).status).toBe(204);
  expect((await app.services.tables.records.query(owner.id, table.id, {})).items).toHaveLength(0);
});

it('keeps the receipt when a saved action moves a record outside its card filter', async () => {
  const scripts: Parameters<typeof scriptedModel>[0] = [];
  const model = scriptedModel(scripts);
  const app = createTestApp({}, { languageModel: model.languageModel });
  const owner = await app.member();
  const base = await app.services.tables.create(owner.id, { name: 'Inbox' });
  const table = base.tables[0]!;
  const field = table.fields[0]!;
  const row = await app.services.tables.records.create(owner.id, table.id, { [field.id]: 'Pending' });
  const created = await app.services.apps.create(owner.id, { base_id: base.id, name: 'Queue', description: '' });
  const draft = await app.services.apps.save(owner.id, created.app.id, {
    revision: created.revision,
    name: 'Queue',
    description: '',
    spec: {
      roles: [],
      pages: [
        {
          id: 'home',
          name: 'Home',
          cards: [
            {
              id: 'pending',
              kind: 'records',
              title: 'Pending',
              table_id: table.id,
              fields: [field.id],
              filter: { mode: 'and', clauses: [{ field: field.id, op: 'eq', value: 'Pending' }] },
              actions: [{ id: 'done', name: 'Complete', type: 'update', values: { [field.id]: 'Done' } }],
            },
          ],
        },
      ],
    },
  });
  await app.services.apps.publish(owner.id, draft.app.id, { revision: draft.revision, notes: '', audience: [] });
  const main = (await app.call('GET', '/api/conversations', { token: owner.token })).body.items[0];
  scripts.push(
    toolCall('apps_action', {
      app_id: created.app.id,
      version: 1,
      card: 'pending',
      action: 'done',
      record_id: row.record.id,
      revision: 1,
    }),
    text('Done'),
  );
  const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
    token: owner.token,
    body: { content: 'Complete it' },
  });
  await app.services.engine.idle();
  const [step] = await getDb()
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.toolName, 'apps_action')));
  expect(step!.status).toBe('succeeded');
  expect((await app.services.tables.records.get(owner.id, row.record.id)).record.values[field.id]).toBe('Done');
  const transcript = (await app.call('GET', `/api/conversations/${main.id}/messages`, { token: owner.token })).body
    .items;
  expect(transcript.some((message: { content: string }) => message.content.includes('修改记录「Done」'))).toBe(true);
  await app.services.engine.undoWrite(owner.id, step!.id);
  expect((await app.services.tables.records.get(owner.id, row.record.id)).record.values[field.id]).toBe('Pending');
});
