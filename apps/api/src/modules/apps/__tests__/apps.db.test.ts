import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AppSpec, Card } from '@greenhouse/contract';
import {
  appVersions,
  baseRecordEvents,
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  pins,
  shares,
} from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

async function setup() {
  const app = createTestApp();
  const lin = await app.member('admin');
  const mei = await app.member('member');
  const kai = await app.member('member');
  const tables = app.services.tables;
  const apps = app.services.apps;
  const base = await tables.create(lin.id, { name: 'Requests' });
  const table = base.tables[0]!;
  const primary = table.fields[0]!;
  const secret = await tables.createField(lin.id, table.id, { name: 'Secret', type: 'text' });
  const state = await tables.createField(lin.id, table.id, { name: 'State', type: 'text' });
  await tables.share(lin.id, base.id, {
    items: [
      { type: 'member', id: mei.id, role: 'editor' },
      { type: 'member', id: kai.id, role: 'viewer' },
    ],
  });
  const created = await apps.create(lin.id, { base_id: base.id, name: 'Office', description: '' });
  const spec: AppSpec = {
    pages: [
      {
        id: 'home',
        name: 'Home',
        cards: [
          {
            id: 'requests',
            kind: 'records',
            title: 'Requests',
            table_id: table.id,
            fields: [primary.id, state.id, secret.id],
            actions: [{ id: 'done', name: 'Done', type: 'update', values: { [state.id]: 'done' } }],
          },
          { id: 'form', kind: 'form', title: 'New', table_id: table.id, fields: [primary.id, state.id], actions: [] },
          { id: 'number', kind: 'number', title: 'Count', table_id: table.id, measure: { aggregate: 'count' } },
          {
            id: 'button',
            kind: 'button',
            title: 'Add',
            table_id: table.id,
            action: {
              id: 'add',
              name: 'Add',
              type: 'create',
              values: { [primary.id]: 'From button', [state.id]: 'new' },
            },
          },
        ],
      },
    ],
    roles: [
      { id: 'staff', name: 'Staff', rules: { tables: { [table.id]: { access: 'edit', hidden_fields: [secret.id] } } } },
    ],
  };
  const draft = await apps.save(lin.id, created.app.id, {
    revision: created.revision,
    name: 'Office',
    description: '',
    spec,
  });
  const publish = () =>
    apps.publish(lin.id, draft.app.id, {
      revision: draft.revision,
      notes: 'First',
      audience: [
        { principal_type: 'member', principal_id: mei.id, role: 'staff' },
        { principal_type: 'member', principal_id: kai.id, role: 'staff' },
      ],
    });
  const row = await tables.records.create(lin.id, table.id, {
    [primary.id]: 'Existing',
    [state.id]: 'new',
    [secret.id]: 'Private',
  });
  return { app, lin, mei, kai, tables, apps, base, table, primary, secret, state, draft, publish, row };
}

describe('apps: published versions, runtime permissions and templates', { timeout: 30000 }, () => {
  it('keeps the draft private, publishes an immutable version, intersects roles, writes as the member and restores only the draft', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    await expect(s.apps.runtime(s.mei.id, id)).rejects.toMatchObject({ status: 404 });
    const published = await s.publish();
    const runtime = await s.apps.runtime(s.mei.id, id);
    expect(runtime.base.tables[0]!.fields.map((f) => f.id)).not.toContain(s.secret.id);
    expect(JSON.stringify(runtime.pages)).not.toContain(s.secret.id);
    const card = await s.apps.card(s.mei.id, id, { version: 1, card: 'requests' });
    expect(card.kind).toBe('records');
    if (card.kind === 'records') expect(card.data.items[0]!.values).not.toHaveProperty(s.secret.id);
    const detail = await s.apps.record(s.mei.id, id, { version: 1, card: 'requests' }, s.row.record.id);
    expect(detail.record.values).not.toHaveProperty(s.secret.id);
    const changed = await s.apps.execute(s.mei.id, id, {
      version: 1,
      card: 'requests',
      action: 'done',
      record_id: s.row.record.id,
      revision: 1,
      values: {},
    });
    expect(changed.record.values[s.state.id]).toBe('done');
    const [event] = await getDb()
      .select()
      .from(baseRecordEvents)
      .where(and(eq(baseRecordEvents.recordId, s.row.record.id), eq(baseRecordEvents.type, 'updated')));
    expect(event).toMatchObject({ actorType: 'app', actorId: s.mei.id, meta: { app_id: id } });
    await s.apps.execute(s.mei.id, id, {
      version: 1,
      card: 'form',
      action: 'submit',
      values: { [s.primary.id]: 'From form', [s.state.id]: 'new' },
    });
    await s.apps.execute(s.mei.id, id, { version: 1, card: 'button', action: 'add', values: {} });
    const count = await s.apps.card(s.mei.id, id, { version: 1, card: 'number' });
    expect(count).toMatchObject({ kind: 'chart', data: { kind: 'number', value: 3 } });
    await expect(
      s.apps.execute(s.kai.id, id, { version: 1, card: 'button', action: 'add', values: {} }),
    ).rejects.toMatchObject({ status: 403 });
    const newer = await s.apps.save(s.lin.id, id, {
      revision: published.revision,
      name: 'Office',
      description: '',
      spec: { ...s.draft.spec, pages: [{ id: 'home', name: 'Changed', cards: [] }] },
    });
    expect((await s.apps.runtime(s.mei.id, id)).pages[0]!.name).toBe('Home');
    await s.apps.publish(s.lin.id, id, { revision: newer.revision, notes: 'Second', audience: published.audience });
    await expect(s.apps.card(s.mei.id, id, { version: 1, card: 'requests' })).rejects.toMatchObject({
      code: 'stale_version',
    });
    const restored = await s.apps.restore(s.lin.id, id, {
      revision: (await s.apps.draft(s.lin.id, id)).revision,
      version: 1,
    });
    expect(restored.spec.pages[0]!.name).toBe('Home');
    const [first] = await getDb()
      .select()
      .from(appVersions)
      .where(and(eq(appVersions.appId, id), eq(appVersions.version, 1)));
    expect(JSON.parse(first!.spec)).toEqual(s.draft.spec);
    expect((await s.apps.versions(s.lin.id, id, { limit: 1 })).next_cursor).toBeTruthy();
  });
  it('refuses base access expansion, hidden writes, stale drafts, cross-base cards and undeclared actions', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    await s.publish();
    await expect(
      s.apps.execute(s.mei.id, id, { version: 1, card: 'form', action: 'submit', values: { [s.secret.id]: 'leak' } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      s.apps.execute(s.mei.id, id, {
        version: 1,
        card: 'button',
        action: 'add',
        values: { [s.primary.id]: 'override' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      s.apps.execute(s.mei.id, id, { version: 1, card: 'button', action: 'not_saved', values: {} }),
    ).rejects.toMatchObject({ status: 404 });
    const foreign = await s.tables.create(s.lin.id, { name: 'Other' });
    await expect(
      s.apps.save(s.lin.id, id, {
        revision: 1,
        name: 'Office',
        description: '',
        spec: {
          pages: [
            {
              id: 'home',
              name: 'Home',
              cards: [{ id: 'foreign', kind: 'number', title: 'Foreign', table_id: foreign.tables[0]!.id } as Card],
            },
          ],
          roles: [],
        },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      s.apps.save(s.lin.id, id, { revision: 1, name: 'Office', description: '', spec: s.draft.spec }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await getDb()
      .delete(shares)
      .where(and(eq(shares.resourceType, 'base'), eq(shares.resourceId, s.base.id), eq(shares.principalId, s.mei.id)));
    await expect(s.apps.runtime(s.mei.id, id)).rejects.toMatchObject({ status: 404 });
    expect((await s.apps.list(s.mei.id, { limit: 200 })).items).toHaveLength(0);
    await getDb()
      .update(members)
      .set({ modules: { apps: false } })
      .where(eq(members.id, s.kai.id));
    await expect(s.apps.list(s.kai.id, { limit: 200 })).rejects.toMatchObject({ status: 403 });
  });
  it('filters detail and update targets by the card query and uses group audiences', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    const spec = {
      ...s.draft.spec,
      pages: s.draft.spec.pages.map((p) => ({
        ...p,
        cards: p.cards.map((c) =>
          c.id === 'requests'
            ? {
                ...c,
                filter: { mode: 'and' as const, clauses: [{ field: s.state.id, op: 'eq' as const, value: 'done' }] },
              }
            : c,
        ),
      })),
    };
    const draft = await s.apps.save(s.lin.id, id, {
      revision: s.draft.revision,
      name: 'Office',
      description: '',
      spec,
    });
    const groupId = newId('group');
    await getDb().insert(groups).values({ id: groupId, name: 'Staff' });
    await getDb().insert(groupMembers).values({ groupId, memberId: s.mei.id });
    await s.apps.publish(s.lin.id, id, {
      revision: draft.revision,
      notes: '',
      audience: [{ principal_type: 'group', principal_id: groupId, role: 'staff' }],
    });
    expect((await s.apps.runtime(s.mei.id, id)).version).toBe(1);
    await expect(s.apps.record(s.mei.id, id, { version: 1, card: 'requests' }, s.row.record.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      s.apps.execute(s.mei.id, id, {
        version: 1,
        card: 'requests',
        action: 'done',
        record_id: s.row.record.id,
        revision: 1,
        values: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('requires template review and installs fresh schema and app references without live records or audience', async () => {
    const s = await setup();
    await s.publish();
    const template = await s.apps.templates.save(s.lin.id, s.draft.app.id, {
      name: 'Office template',
      description: '',
      changelog: 'First',
    });
    expect(template.review_status).toBe('pending');
    await expect(s.apps.templates.install(s.mei.id, template.id)).rejects.toMatchObject({ status: 404 });
    await expect(s.apps.templates.review(s.mei.id, template.id, 'approved')).rejects.toMatchObject({ status: 404 });
    const content = await s.apps.templates.get(s.lin.id, template.id);
    expect(JSON.stringify(content.content)).not.toContain('Private');
    await s.apps.templates.review(s.lin.id, template.id, 'approved');
    const installed = await s.apps.templates.install(s.mei.id, template.id, 'New office');
    expect(installed.base.owner_id).toBe(s.mei.id);
    expect(installed.app!.audience).toEqual([]);
    const table = installed.base.tables[0]!;
    expect(table.id).not.toBe(s.table.id);
    expect((await s.tables.records.query(s.mei.id, table.id, { limit: 200 })).items).toHaveLength(0);
    const card = installed.app!.spec.pages[0]!.cards[0]!;
    expect('table_id' in card && card.table_id).toBe(table.id);
    expect(JSON.stringify(installed.app!.spec)).not.toContain(s.primary.id);
    const builtins = await s.apps.templates.list(s.mei.id, { limit: 200 });
    const project = builtins.items.find((t) => t.key === 'project')!;
    expect((await s.apps.templates.install(s.mei.id, project.id)).base.tables).toHaveLength(2);
  });
  it('serves the typed routes and searches only accessible apps', async () => {
    const s = await setup();
    await s.publish();
    const id = s.draft.app.id;
    expect((await s.app.call('GET', `/api/apps/${id}`, { token: s.mei.token })).status).toBe(200);
    expect((await s.app.call('GET', `/api/apps/${id}/draft`, { token: s.mei.token })).status).toBe(403);
    expect(
      (
        await s.app.call('POST', `/api/apps/${id}/actions`, {
          token: s.mei.token,
          body: { version: 1, card: 'button', action: 'add' },
        })
      ).status,
    ).toBe(200);
    const result = await s.app.services.search.search(s.mei.id, { q: 'Office', kinds: ['apps'], limit: 5 });
    expect(result.items).toMatchObject([{ kind: 'apps', id }]);
  });
  it('previews the draft role read-only and never exposes fields from shared view configurations', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    const preview = await s.apps.runtime(s.lin.id, id, 'staff');
    expect(preview).toMatchObject({ preview: true, version: 0, preview_role: 'staff' });
    expect(preview.base.views).toEqual([]);
    expect(preview.base.tables[0]!.fields.map((f) => f.id)).not.toContain(s.secret.id);
    const answer = await s.apps.card(s.lin.id, id, { version: 0, card: 'requests', preview_role: 'staff' });
    expect(answer.kind).toBe('records');
    if (answer.kind === 'records') expect(answer.data.items[0]!.values).not.toHaveProperty(s.secret.id);
    await expect(s.apps.runtime(s.mei.id, id, 'staff')).rejects.toMatchObject({ status: 404 });
  });
  it('unions application roles and then intersects their rows with the base role', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    await s.tables.records.create(s.lin.id, s.table.id, { [s.primary.id]: 'Done', [s.state.id]: 'done' });
    await s.tables.records.create(s.lin.id, s.table.id, { [s.primary.id]: 'Other', [s.state.id]: 'other' });
    const spec = {
      ...s.draft.spec,
      roles: ['new', 'done'].map((value) => ({
        id: value,
        name: value,
        rules: {
          tables: {
            [s.table.id]: {
              access: 'edit' as const,
              rows: { mode: 'and' as const, clauses: [{ field: s.state.id, op: 'eq' as const, value }] },
              hidden_fields: [s.secret.id],
            },
          },
        },
      })),
    };
    const draft = await s.apps.save(s.lin.id, id, {
      revision: s.draft.revision,
      name: 'Office',
      description: '',
      spec,
    });
    const groupId = newId('group');
    await getDb().insert(groups).values({ id: groupId, name: 'Both' });
    await getDb().insert(groupMembers).values({ groupId, memberId: s.mei.id });
    await s.apps.publish(s.lin.id, id, {
      revision: draft.revision,
      notes: '',
      audience: [
        { principal_type: 'member', principal_id: s.mei.id, role: 'new' },
        { principal_type: 'group', principal_id: groupId, role: 'done' },
      ],
    });
    expect(await s.apps.card(s.mei.id, id, { version: 1, card: 'number' })).toMatchObject({
      kind: 'chart',
      data: { value: 2 },
    });
    const role = await s.tables.roles.create(s.lin.id, s.base.id, {
      name: 'Only done',
      rules: {
        tables: {
          [s.table.id]: {
            access: 'edit',
            rows: { mode: 'and', clauses: [{ field: s.state.id, op: 'eq', value: 'done' }] },
          },
        },
      },
    });
    await s.tables.share(s.lin.id, s.base.id, {
      items: [{ type: 'member', id: s.mei.id, role: 'custom', custom_role_id: role.id }],
    });
    expect(await s.apps.card(s.mei.id, id, { version: 1, card: 'number' })).toMatchObject({
      kind: 'chart',
      data: { value: 1 },
    });
  });
  it('lets an action leave its card query but never the application role', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    const spec = {
      ...s.draft.spec,
      pages: s.draft.spec.pages.map((p) => ({
        ...p,
        cards: p.cards.map((c) =>
          c.id === 'requests'
            ? {
                ...c,
                filter: { mode: 'and' as const, clauses: [{ field: s.state.id, op: 'eq' as const, value: 'new' }] },
              }
            : c,
        ),
      })),
    };
    const draft = await s.apps.save(s.lin.id, id, {
      revision: s.draft.revision,
      name: 'Office',
      description: '',
      spec,
    });
    await s.apps.publish(s.lin.id, id, {
      revision: draft.revision,
      notes: '',
      audience: [{ principal_type: 'member', principal_id: s.mei.id, role: 'staff' }],
    });
    await s.apps.execute(s.mei.id, id, {
      version: 1,
      card: 'requests',
      action: 'done',
      record_id: s.row.record.id,
      revision: 1,
      values: {},
    });
    const answer = await s.apps.card(s.mei.id, id, { version: 1, card: 'requests' });
    expect(answer.kind === 'records' && answer.data.items).toEqual([]);
  });
  it('removes app versions, audience grants and pins when their base is deleted', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    await s.publish();
    await s.apps.pin(s.mei.id, id, true);
    await s.tables.remove(s.lin.id, s.base.id, s.base.name);
    expect(await getDb().select().from(appVersions).where(eq(appVersions.appId, id))).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(shares)
        .where(and(eq(shares.resourceType, 'app'), eq(shares.resourceId, id))),
    ).toEqual([]);
    expect(
      await getDb()
        .select()
        .from(pins)
        .where(and(eq(pins.targetType, 'app'), eq(pins.targetId, id))),
    ).toEqual([]);
  });
  it('shows permitted linked titles and computed columns without revealing the unchosen inputs', async () => {
    const s = await setup();
    const id = s.draft.app.id;
    const projects = await s.tables.createTable(s.lin.id, s.base.id, 'Projects');
    const projectName = projects.fields.find((f) => f.is_primary)!;
    const project = await s.tables.records.create(s.lin.id, projects.id, { [projectName.id]: 'Project one' });
    const link = await s.tables.createField(s.lin.id, s.table.id, {
      name: 'Project',
      type: 'relation',
      config: { table_id: projects.id, multiple: false },
    });
    const hours = await s.tables.createField(s.lin.id, s.table.id, { name: 'Hours', type: 'number' });
    const double = await s.tables.createField(s.lin.id, s.table.id, {
      name: 'Double',
      type: 'formula',
      config: { formula_text: '{Hours} * 2' },
    });
    const spec = {
      ...s.draft.spec,
      roles: s.draft.spec.roles.map((r) => ({
        ...r,
        rules: { tables: { ...r.rules.tables, [projects.id]: { access: 'read' as const } } },
      })),
      pages: s.draft.spec.pages.map((p) => ({
        ...p,
        cards: p.cards.map((c) =>
          c.id === 'requests' && 'fields' in c
            ? { ...c, fields: [s.primary.id, link.id, double.id] }
            : c.id === 'form' && 'fields' in c
              ? { ...c, fields: [s.primary.id, link.id, hours.id] }
              : c,
        ),
      })),
    };
    const draft = await s.apps.save(s.lin.id, id, {
      revision: s.draft.revision,
      name: 'Office',
      description: '',
      spec,
    });
    await s.apps.publish(s.lin.id, id, {
      revision: draft.revision,
      notes: '',
      audience: [{ principal_type: 'member', principal_id: s.mei.id, role: 'staff' }],
    });
    const created = await s.apps.execute(s.mei.id, id, {
      version: 1,
      card: 'form',
      action: 'submit',
      values: { [s.primary.id]: 'With project', [link.id]: [project.record.id], [hours.id]: 3 },
    });
    const detail = await s.apps.record(s.mei.id, id, { version: 1, card: 'requests' }, created.record.id);
    expect(detail.record.values[double.id]).toBe(6);
    expect(detail.record.values).not.toHaveProperty(hours.id);
    expect(detail.linked[project.record.id]?.title).toBe('Project one');
    const template = await s.apps.templates.save(s.lin.id, id, {
      name: 'Computed template',
      description: '',
      changelog: '',
    });
    await s.apps.templates.review(s.lin.id, template.id, 'approved');
    const installed = await s.apps.templates.install(s.mei.id, template.id);
    const requests = installed.base.tables.find((t) => t.name === s.table.name)!;
    const ownHours = requests.fields.find((f) => f.name === 'Hours')!;
    const ownDouble = requests.fields.find((f) => f.name === 'Double')!;
    const title = requests.fields.find((f) => f.is_primary)!;
    const row = await s.tables.records.create(s.mei.id, requests.id, {
      [title.id]: 'Template computation',
      [ownHours.id]: 4,
    });
    expect(row.record.values[ownDouble.id]).toBe(8);
  });
  it('keeps a published app usable by its owner after builder access becomes viewer access', async () => {
    const s = await setup();
    await s.tables.share(s.lin.id, s.base.id, { items: [{ type: 'member', id: s.mei.id, role: 'builder' }] });
    const draft = await s.apps.create(s.mei.id, { base_id: s.base.id, name: 'Mei app', description: '' });
    await expect(s.apps.draft(s.lin.id, draft.app.id)).rejects.toMatchObject({ status: 404 });
    await s.apps.publish(s.mei.id, draft.app.id, { revision: draft.revision, notes: '', audience: [] });
    await s.tables.share(s.lin.id, s.base.id, { items: [{ type: 'member', id: s.mei.id, role: 'viewer' }] });
    expect(await s.apps.runtime(s.mei.id, draft.app.id)).toMatchObject({
      app: { editable: false },
      base: { access: 'viewer' },
    });
    await expect(s.apps.draft(s.mei.id, draft.app.id)).rejects.toMatchObject({ status: 403 });
  });
});
