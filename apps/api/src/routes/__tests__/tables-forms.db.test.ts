/**
 * Tables slice Fm (spec 20261011-tables-foundation §3, acceptance 5), real
 * PostgreSQL through the HTTP routers: form audiences (Base / everyone /
 * people and groups), the submit view, locked defaults, single submission,
 * relation fields kept off outside forms, and form-scoped attachment uploads.
 * The concurrent double submit is in tables-forms.db-commit.test.ts (it needs
 * two real connections).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { TableFormAudience, TableFormSubmitView, TableFormUploadView } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import formRoutes from '../forms.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { sweepStaleFormUploads } from '../../platform/tables/form-uploads.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { deleteObjectAtKey, getObjectAtKey } from '../../storage/uploads.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let outsider: UserRow;
let another: UserRow;
const storedKeys: string[] = [];
/** Form names are unique per table. */
let formCount = 0;

function createHttpApp(users: UserRow[]) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/tables', tablesRoutes);
  app.route('/api/forms', formRoutes);
  return app;
}

type App = ReturnType<typeof createHttpApp>;

function send(app: App, user: UserRow, path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function upload(app: App, user: UserRow, formId: number, name = 'receipt.pdf') {
  const body = new FormData();
  body.append('file', new File([`bytes of ${name}`], name, { type: 'application/pdf' }));
  return app.request(`/api/forms/${formId}/uploads`, { method: 'POST', body, headers: { 'x-test-user': user.id } });
}

async function uploaded(app: App, user: UserRow, formId: number, name?: string): Promise<TableFormUploadView> {
  const response = await upload(app, user, formId, name);
  expect(response.status).toBe(201);
  const { file } = (await response.json()) as { file: TableFormUploadView };
  const row = await db.drive.getFile(file.id);
  if (row) storedKeys.push(row.cos_key);
  return file;
}

interface Fixture {
  baseId: number;
  tableId: number;
  primaryId: number;
}

async function createBase(app: App): Promise<Fixture> {
  const response = await send(app, owner, '/api/tables/bases', 'POST', { name: 'Forms Base' });
  expect(response.status).toBe(201);
  const created = (await response.json()) as {
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  };
  return { baseId: created.base.id, tableId: created.schema.table.id, primaryId: created.schema.fields[0]!.id };
}

async function addField(app: App, tableId: number, name: string, type: string, config?: unknown) {
  const response = await send(app, owner, `/api/tables/tables/${tableId}/fields`, 'POST', { name, type, config });
  expect(response.status).toBe(201);
  return ((await response.json()) as { field: { id: number } }).field.id;
}

async function addMember(app: App, baseId: number, user: UserRow, role: 'viewer' | 'editor') {
  const response = await send(app, owner, `/api/tables/bases/${baseId}/members/${user.id}`, 'PUT', { role });
  expect(response.status).toBe(200);
}

async function createForm(
  app: App,
  tableId: number,
  config: Record<string, unknown>,
  audience?: TableFormAudience,
  status: 'draft' | 'published' = 'published',
) {
  formCount += 1;
  return send(app, owner, `/api/tables/tables/${tableId}/forms`, 'POST', {
    name: `Intake ${formCount}`,
    status,
    config: { title: 'Intake', successMessage: 'Thanks!', ...config },
    ...(audience ? { audience } : {}),
  });
}

async function formId(app: App, tableId: number, config: Record<string, unknown>, audience?: TableFormAudience) {
  const response = await createForm(app, tableId, config, audience);
  expect(response.status).toBe(201);
  return ((await response.json()) as { form: { id: number } }).form.id;
}

async function records(app: App, tableId: number) {
  const response = await send(app, owner, `/api/tables/tables/${tableId}/records/query`, 'POST', {});
  expect(response.status).toBe(200);
  return (
    (await response.json()) as { records: Array<{ id: number; created_by: string; values: Record<string, unknown> }> }
  ).records;
}

describe('Tables forms (slice Fm)', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    [owner, outsider, another] = await Promise.all([
      createInternalTestUser(db, { email: 'tables-fm-owner@test.com' }),
      createInternalTestUser(db, { email: 'tables-fm-outsider@test.com' }),
      createInternalTestUser(db, { email: 'tables-fm-another@test.com' }),
    ]);
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    for (const key of storedKeys.splice(0)) await deleteObjectAtKey(key).catch(() => undefined);
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('lets a team member outside the Base submit to an everyone form, and read nothing afterwards', async () => {
    const app = createHttpApp([owner, outsider]);
    const { baseId, tableId, primaryId } = await createBase(app);
    const id = await formId(app, tableId, { fieldIds: [primaryId] }, { type: 'team' });

    const open = await send(app, outsider, `/api/forms/${id}`);
    expect(open.status).toBe(200);
    const view = ((await open.json()) as { form: TableFormSubmitView }).form;
    expect(view).toMatchObject({ id, title: 'Intake', alreadySubmitted: false, allowMultiple: true });
    expect(view.fields.map((field) => field.id)).toEqual([primaryId]);
    // The submit view only: no Base, table, member or record data rides along.
    expect(Object.keys(view).sort()).toEqual([
      'allowMultiple',
      'alreadySubmitted',
      'description',
      'fields',
      'id',
      'name',
      'submitLabel',
      'successMessage',
      'title',
    ]);

    const submitted = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', {
      values: { [primaryId]: 'From outside' },
    });
    expect(submitted.status).toBe(201);
    expect(await submitted.json()).toEqual({ submitted: true, successMessage: 'Thanks!' });

    const [record] = await records(app, tableId);
    expect(record).toMatchObject({ created_by: outsider.id, values: { [primaryId]: 'From outside' } });
    expect((await db.tables.listRecordEvents(record!.id))[0]).toMatchObject({
      actor_id: outsider.id,
      actor_kind: 'form',
    });

    // The submitter never became a reader of the Base.
    expect((await send(app, outsider, `/api/tables/bases/${baseId}`)).status).toBe(404);
    expect((await send(app, outsider, `/api/tables/tables/${tableId}/records/query`, 'POST', {})).status).toBe(404);
    expect((await send(app, outsider, `/api/tables/tables/${tableId}/records/${record!.id}`)).status).toBe(404);
    expect((await send(app, outsider, `/api/tables/forms/${id}`)).status).toBe(404);
  });

  it('serves no submit label or success message when the builder left them empty (each respondent’s own language)', async () => {
    const app = createHttpApp([owner, outsider]);
    const { tableId, primaryId } = await createBase(app);
    const id = await formId(app, tableId, { fieldIds: [primaryId], successMessage: undefined }, { type: 'team' });
    const view = ((await (await send(app, outsider, `/api/forms/${id}`)).json()) as { form: TableFormSubmitView }).form;
    expect(view).toMatchObject({ submitLabel: null, successMessage: null });
    const submitted = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', { values: { [primaryId]: 'x' } });
    expect(await submitted.json()).toEqual({ submitted: true, successMessage: null });
  });

  it('admits listed people and group members, never a group creator who is not in the group', async () => {
    const lead = await createInternalTestUser(db, { email: 'tables-fm-lead@test.com' });
    const listed = await createInternalTestUser(db, { email: 'tables-fm-listed@test.com' });
    const app = createHttpApp([owner, outsider, another, lead, listed]);
    const { tableId, primaryId } = await createBase(app);
    const group = await db.groups.create({ name: 'Finance', created_by: lead.id });
    await db.groups.addMembers(group.id, [another.id, owner.id], lead.id);

    const id = await formId(
      app,
      tableId,
      { fieldIds: [primaryId] },
      { type: 'principals', userIds: [listed.id], groupIds: [group.id] },
    );
    expect((await send(app, another, `/api/forms/${id}`)).status).toBe(200);
    expect((await send(app, listed, `/api/forms/${id}`)).status).toBe(200);
    expect((await send(app, lead, `/api/forms/${id}`)).status).toBe(404);
    expect((await send(app, outsider, `/api/forms/${id}`)).status).toBe(404);
    expect(
      (await send(app, outsider, `/api/forms/${id}/submit`, 'POST', { values: { [primaryId]: 'Nope' } })).status,
    ).toBe(404);
    const submitted = await send(app, another, `/api/forms/${id}/submit`, 'POST', {
      values: { [primaryId]: 'Via the group' },
    });
    expect(submitted.status).toBe(201);
    expect((await records(app, tableId)).map((record) => record.created_by)).toEqual([another.id]);

    // A builder cannot name a group they can neither see nor belong to.
    const hidden = await db.groups.create({ name: 'Private', created_by: outsider.id });
    const refused = await createForm(
      app,
      tableId,
      { fieldIds: [primaryId] },
      { type: 'principals', userIds: [], groupIds: [hidden.id] },
    );
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ details: { reason: 'group_not_found' } });
  });

  it('lets a form be edited after someone on its list was deactivated, but not add such a person', async () => {
    const app = createHttpApp([owner, outsider, another]);
    const { tableId, primaryId } = await createBase(app);
    const audience = { type: 'principals' as const, userIds: [outsider.id], groupIds: [] };
    const id = await formId(app, tableId, { fieldIds: [primaryId] }, audience);
    await db.users.update(outsider.id, { status: 'disabled' });
    await db.users.update(another.id, { status: 'disabled' });

    const read = await send(app, owner, `/api/tables/forms/${id}`);
    const { revision } = ((await read.json()) as { form: { revision: number } }).form;
    const kept = await send(app, owner, `/api/tables/forms/${id}`, 'PATCH', {
      revision,
      name: 'Renamed',
      audience,
      config: { fieldIds: [primaryId] },
    });
    expect(kept.status).toBe(200);
    const added = await send(app, owner, `/api/tables/forms/${id}`, 'PATCH', {
      revision: revision + 1,
      audience: { ...audience, userIds: [outsider.id, another.id] },
    });
    expect(added.status).toBe(400);
  });

  it('keeps a Base-audience form to members who can create records', async () => {
    const app = createHttpApp([owner, outsider, another]);
    const { baseId, tableId, primaryId } = await createBase(app);
    await addMember(app, baseId, outsider, 'viewer');
    await addMember(app, baseId, another, 'editor');
    const id = await formId(app, tableId, { fieldIds: [primaryId] });

    expect((await send(app, outsider, `/api/forms/${id}`)).status).toBe(404);
    expect(
      (await send(app, outsider, `/api/forms/${id}/submit`, 'POST', { values: { [primaryId]: 'Viewer' } })).status,
    ).toBe(404);
    expect((await send(app, another, `/api/forms/${id}`)).status).toBe(200);
    expect(
      (await send(app, another, `/api/forms/${id}/submit`, 'POST', { values: { [primaryId]: 'Editor' } })).status,
    ).toBe(201);
  });

  it('tells only the audience that a form is still a draft', async () => {
    const app = createHttpApp([owner, outsider]);
    const { tableId, primaryId } = await createBase(app);
    const response = await createForm(app, tableId, { fieldIds: [primaryId] }, { type: 'team' }, 'draft');
    const id = ((await response.json()) as { form: { id: number } }).form.id;
    const open = await send(app, outsider, `/api/forms/${id}`);
    expect(open.status).toBe(404);
    expect(await open.json()).toMatchObject({ details: { reason: 'not_published' } });

    const base = await createForm(app, tableId, { fieldIds: [primaryId] }, undefined, 'draft');
    const baseFormId = ((await base.json()) as { form: { id: number } }).form.id;
    const hidden = await send(app, outsider, `/api/forms/${baseFormId}`);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: 'Form not found' });
  });

  it('accepts one submission per person on a single-submit form', async () => {
    const app = createHttpApp([owner, outsider, another]);
    const { tableId, primaryId } = await createBase(app);
    const id = await formId(app, tableId, { fieldIds: [primaryId], allowMultiple: false }, { type: 'team' });

    const first = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', { values: { [primaryId]: 'One' } });
    expect(first.status).toBe(201);
    const second = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', { values: { [primaryId]: 'Two' } });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ details: { reason: 'already_submitted' } });
    const view = ((await (await send(app, outsider, `/api/forms/${id}`)).json()) as { form: TableFormSubmitView }).form;
    expect(view).toMatchObject({ alreadySubmitted: true, allowMultiple: false });
    // Someone else still has their one go.
    expect(
      (await send(app, another, `/api/forms/${id}/submit`, 'POST', { values: { [primaryId]: 'Mine' } })).status,
    ).toBe(201);
    expect((await records(app, tableId)).map((record) => record.values[String(primaryId)]).sort()).toEqual([
      'Mine',
      'One',
    ]);
  });

  it('keeps relation fields off forms for people outside the Base', async () => {
    const app = createHttpApp([owner]);
    const { baseId, tableId, primaryId } = await createBase(app);
    const other = await send(app, owner, `/api/tables/bases/${baseId}/tables`, 'POST', { name: 'Projects' });
    expect(other.status).toBe(201);
    const otherTableId = ((await other.json()) as { table: { id: number } }).table.id;
    const relationId = await addField(app, tableId, 'Project', 'relation', {
      relation: { targetTableId: otherTableId },
    });

    const refused = await createForm(app, tableId, { fieldIds: [primaryId, relationId] }, { type: 'team' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/relation/);

    const id = await formId(app, tableId, { fieldIds: [primaryId, relationId] });
    const form = ((await (await send(app, owner, `/api/tables/forms/${id}`)).json()) as { form: { revision: number } })
      .form;
    const widened = await send(app, owner, `/api/tables/forms/${id}`, 'PATCH', {
      revision: form.revision,
      audience: { type: 'team' },
    });
    expect(widened.status).toBe(400);
  });

  it('resolves and locks prefilled values on the server', async () => {
    const app = createHttpApp([owner, outsider]);
    const { tableId, primaryId } = await createBase(app);
    const requesterId = await addField(app, tableId, 'Requester', 'user');
    const dayId = await addField(app, tableId, 'Requested on', 'date');
    const id = await formId(
      app,
      tableId,
      {
        fieldIds: [primaryId],
        defaults: [
          { fieldId: requesterId, value: '$me' },
          { fieldId: dayId, value: '$today' },
        ],
      },
      { type: 'team' },
    );

    const view = ((await (await send(app, outsider, `/api/forms/${id}`)).json()) as { form: TableFormSubmitView }).form;
    expect(view.fields.map((field) => field.id)).toEqual([primaryId]);

    const submitted = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', {
      values: { [primaryId]: 'Laptop', [requesterId]: owner.id, [dayId]: '2001-01-01' },
      timeZone: 'UTC',
    });
    expect(submitted.status).toBe(201);
    const [record] = await records(app, tableId);
    expect(record!.values).toMatchObject({
      [primaryId]: 'Laptop',
      [requesterId]: outsider.id,
      [dayId]: new Date().toISOString().slice(0, 10),
    });

    const both = await createForm(app, tableId, {
      fieldIds: [primaryId, requesterId],
      defaults: [{ fieldId: requesterId, value: '$me' }],
    });
    expect(both.status).toBe(400);
    const wrongToken = await createForm(app, tableId, {
      fieldIds: [primaryId],
      defaults: [{ fieldId: dayId, value: '$me' }],
    });
    expect(wrongToken.status).toBe(400);
  });

  it('binds only files the submitter uploaded through this form, and sweeps the ones never submitted', async () => {
    const app = createHttpApp([owner, outsider, another]);
    const { tableId, primaryId } = await createBase(app);
    const filesId = await addField(app, tableId, 'Receipts', 'attachment');
    const id = await formId(app, tableId, { fieldIds: [primaryId, filesId] }, { type: 'team' });
    const plain = await formId(app, tableId, { fieldIds: [primaryId] }, { type: 'team' });

    const mine = await uploaded(app, outsider, id, 'mine.pdf');
    expect(await db.drive.getFile(mine.id)).toMatchObject({ status: 'pending', uploaded_by: outsider.id });
    expect((await upload(app, outsider, plain)).status).toBe(400);
    expect((await upload(app, outsider, id, 'run.sh')).status).toBe(400);

    // Someone else's staged file is not theirs to attach.
    const theirs = await uploaded(app, another, id, 'theirs.pdf');
    const stolen = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', {
      values: { [primaryId]: 'Stolen', [filesId]: [theirs.id] },
    });
    expect(stolen.status).toBe(400);
    expect(await db.drive.getFile(theirs.id)).toMatchObject({ status: 'pending' });

    const submitted = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', {
      values: { [primaryId]: 'With receipt', [filesId]: [mine.id] },
    });
    expect(submitted.status).toBe(201);
    const [record] = await records(app, tableId);
    expect(record!.values[String(filesId)]).toEqual([mine.id]);
    expect(await db.drive.getFile(mine.id)).toMatchObject({ status: 'active' });
    expect((await db.tables.listRecordAttachments(record!.id, filesId)).map((row) => row.drive_file_id)).toEqual([
      mine.id,
    ]);
    const stored = await db.drive.getFile(mine.id);
    expect((await getObjectAtKey(stored!.cos_key))?.buffer.toString()).toBe('bytes of mine.pdf');

    // A bound file cannot be bound again.
    const again = await send(app, outsider, `/api/forms/${id}/submit`, 'POST', {
      values: { [primaryId]: 'Again', [filesId]: [mine.id] },
    });
    expect(again.status).toBe(400);

    // The other person's never-submitted upload is swept once it is a day old.
    await db.executeRaw(
      sql`UPDATE drive_files SET created_at = now() - interval '25 hours' WHERE id IN (${theirs.id}, ${mine.id})`,
    );
    expect(await sweepStaleFormUploads(db)).toBe(1);
    expect(await db.drive.getFile(theirs.id)).toMatchObject({ status: 'deleted' });
    expect(await db.drive.getFile(mine.id)).toMatchObject({ status: 'active' });
  });
});
