/** Internal forms (TBL-11): building, who may submit, filling in, files, single submit and submissions. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  formFillSchema,
  formReceiptSchema,
  formSchema,
  formSharesSchema,
  formSubmissionSchema,
  formUploadSchema,
  pageSchema,
  type RealtimeEvent,
  type TokenPair,
} from '@greenhouse/contract';
import { createApiClient } from '@greenhouse/contract/client';
import {
  baseFields,
  baseFormSubmissions,
  baseRecordEvents,
  baseRecordFiles,
  baseRoles,
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  shares,
} from '@greenhouse/db';
import { z } from 'zod';
import { streamedUpload } from '../../files/__tests__/streamed-upload.js';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-forms-')) });
  const person = async (name: string) => {
    const who = await app.member('member', `${name.toLowerCase()}-${newId('member').toLowerCase()}@example.com`);
    await getDb().update(members).set({ name, timezone: 'Asia/Shanghai' }).where(eq(members.id, who.id));
    return { ...who, name };
  };
  const lin = await person('Lin');
  const mei = await person('Mei');
  const kai = await person('Kai');
  const ann = await person('Ann');
  const as = (who: Who) => ({
    get: (path: string) => app.call('GET', path, { token: who.token }),
    post: (path: string, body: unknown = {}) => app.call('POST', path, { token: who.token, body }),
    patch: (path: string, body: unknown) => app.call('PATCH', path, { token: who.token, body }),
    put: (path: string, body: unknown) => app.call('PUT', path, { token: who.token, body }),
    del: (path: string) => app.call('DELETE', path, { token: who.token }),
  });
  const upload = async (who: Who, formId: string, name = 'notes.txt', text = 'hello') => {
    const form = new FormData();
    form.set('file', new File([text], name, { type: 'text/plain' }));
    const response = await app.app.request(`/api/tables/forms/${formId}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who.token}` },
      body: form,
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  function listen(who: Who) {
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(who.id, (event) => events.push(event));
    return events;
  }
  return { app, lin, mei, kai, ann, person, as, upload, listen };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * Lin's base with a data table of requests: a title, a status, a count, a member, files and a
 * long note. Mei edits the base, Kai views it, Ann has no part in it.
 */
async function requests({ lin, mei, kai, as }: Setup) {
  const base = (await as(lin).post('/api/tables/bases', { name: 'Office' })).body;
  const table = base.tables[0];
  const field = async (body: object) => {
    const made = await as(lin).post(`/api/tables/tables/${table.id}/fields`, body);
    expect(made.status).toBe(201);
    return made.body;
  };
  const status = await field({
    name: 'Status',
    type: 'single_select',
    config: {
      options: [
        { id: 'new', label: 'New', color: 'gray' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
  });
  const count = await field({ name: 'Count', type: 'number' });
  const owner = await field({ name: 'Owner', type: 'member' });
  const files = await field({ name: 'Files', type: 'attachment' });
  const note = await field({ name: 'Note', type: 'long_text' });
  await as(lin).put(`/api/tables/bases/${base.id}/share`, {
    items: [
      { type: 'member', id: mei.id, role: 'editor' },
      { type: 'member', id: kai.id, role: 'viewer' },
    ],
  });
  return { base, table, primary: table.fields[0], status, count, owner, files, note };
}

/** A published form of the requests table, asking for a title, a count and files. */
async function published(s: Setup, extra: Record<string, unknown> = {}) {
  const at = await requests(s);
  const made = await s.as(s.lin).post(`/api/tables/tables/${at.table.id}/forms`, {
    name: 'Ask for supplies',
    description: 'What do you need?',
    config: {
      fields: [
        { field_id: at.primary.id, label: 'What', required: true },
        { field_id: at.count.id, help: 'How many' },
        { field_id: at.files.id },
      ],
      success_message: 'Thanks, we will order it.',
      ...extra,
    },
  });
  expect(made.status).toBe(201);
  expect((await s.as(s.lin).post(`/api/tables/forms/${made.body.id}/publish`)).body.status).toBe('published');
  return { ...at, form: made.body };
}

describe('building forms', () => {
  it('makes a draft from the table, changes it with its revision, publishes and unpublishes it', async () => {
    const s = await setup();
    const { lin, mei, kai, as, listen } = s;
    const { base, table, primary, status, count, owner, files, note } = await requests(s);
    const told = listen(mei);
    const made = await as(lin).post(`/api/tables/tables/${table.id}/forms`, { name: 'Requests' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      base_id: base.id,
      table_id: table.id,
      name: 'Requests',
      description: '',
      status: 'draft',
      revision: 1,
      submission_count: 0,
    });
    // A new form asks for every field a person fills in, in the table's order.
    expect(made.body.config.fields.map((item: any) => item.field_id)).toEqual([
      primary.id,
      status.id,
      count.id,
      owner.id,
      files.id,
      note.id,
    ]);
    expect(told.some((event) => event.type === 'base.updated')).toBe(true);
    const formId = made.body.id;
    expect((await as(lin).get(`/api/tables/tables/${table.id}/forms`)).body.items).toEqual([made.body]);

    const changed = await as(lin).patch(`/api/tables/forms/${formId}`, {
      revision: 1,
      name: 'Supplies',
      config: {
        fields: [{ field_id: count.id, label: 'How many', help: 'Boxes', required: true }, { field_id: primary.id }],
        submit_label: 'Send',
        single_submit: true,
      },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      name: 'Supplies',
      revision: 2,
      config: {
        fields: [{ field_id: count.id, label: 'How many', help: 'Boxes', required: true }, { field_id: primary.id }],
        submit_label: 'Send',
        single_submit: true,
      },
    });
    // Only the keys sent change; '' clears a text.
    const cleared = await as(lin).patch(`/api/tables/forms/${formId}`, {
      revision: 2,
      config: { submit_label: '', success_message: 'Got it' },
    });
    expect(cleared.body.config).toEqual({
      fields: changed.body.config.fields,
      success_message: 'Got it',
      single_submit: true,
    });
    const stale = await as(lin).patch(`/api/tables/forms/${formId}`, { revision: 2, name: 'Old' });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'stale_revision' } } });
    expect(stale.body.error.details.form.revision).toBe(3);

    // Only live fields of this table, each once.
    const other = (await as(lin).post(`/api/tables/bases/${base.id}/tables`, { name: 'Other' })).body;
    const foreign = await as(lin).patch(`/api/tables/forms/${formId}`, {
      revision: 3,
      config: { fields: [{ field_id: other.fields[0].id }] },
    });
    expect(foreign).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_input', details: { field: other.fields[0].id } } },
    });
    const twice = await as(lin).patch(`/api/tables/forms/${formId}`, {
      revision: 3,
      config: { fields: [{ field_id: count.id }, { field_id: count.id }] },
    });
    expect(twice.status).toBe(400);

    // Builders only: an editor of the base finds no such form to change.
    expect((await as(mei).get(`/api/tables/forms/${formId}`)).status).toBe(404);
    expect((await as(mei).patch(`/api/tables/forms/${formId}`, { revision: 3, name: 'X' })).status).toBe(404);
    expect((await as(mei).get(`/api/tables/tables/${table.id}/forms`)).status).toBe(403);
    expect((await as(kai).post(`/api/tables/tables/${table.id}/forms`, { name: 'X' })).status).toBe(403);

    // A draft is closed to those who may submit, and a preview for builders that takes nothing.
    expect(await as(mei).get(`/api/tables/forms/${formId}/fill`)).toMatchObject({
      status: 409,
      body: { error: { code: 'form_closed' } },
    });
    const preview = await as(lin).get(`/api/tables/forms/${formId}/fill`);
    expect(preview.body).toMatchObject({ status: 'draft', submit_label: '', success_message: 'Got it' });
    expect(
      (await as(lin).post(`/api/tables/forms/${formId}/submissions`, { values: { [primary.id]: 'Try' } })).body.error
        .code,
    ).toBe('form_closed');

    expect((await as(lin).post(`/api/tables/forms/${formId}/publish`)).body).toMatchObject({
      status: 'published',
      revision: 3,
    });
    expect((await as(mei).get(`/api/tables/forms/${formId}/fill`)).status).toBe(200);
    expect((await as(lin).post(`/api/tables/forms/${formId}/unpublish`)).body.status).toBe('draft');
    expect((await as(mei).get(`/api/tables/forms/${formId}/fill`)).status).toBe(409);

    // A form with no fields cannot be published.
    await as(lin).patch(`/api/tables/forms/${formId}`, { revision: 3, config: { fields: [] } });
    expect((await as(lin).post(`/api/tables/forms/${formId}/publish`)).status).toBe(400);
  });

  it('always asks for the fields the table requires and never for computed ones', async () => {
    const s = await setup();
    const { lin, as } = s;
    const { table, primary, count } = await requests(s);
    const due = (
      await as(lin).post(`/api/tables/tables/${table.id}/fields`, { name: 'Due', type: 'date', required: true })
    ).body;
    const formula = newId('baseField');
    await getDb()
      .insert(baseFields)
      .values({ id: formula, tableId: table.id, name: 'Total', type: 'formula', position: 99 });
    const made = await as(lin).post(`/api/tables/tables/${table.id}/forms`, {
      name: 'Short',
      config: { fields: [{ field_id: count.id }] },
    });
    expect(made.body.config.fields).toEqual([{ field_id: count.id }, { field_id: due.id }]);
    const all = await as(lin).post(`/api/tables/tables/${table.id}/forms`, { name: 'All' });
    expect(all.body.config.fields.map((item: any) => item.field_id)).not.toContain(formula);
    const computed = await as(lin).patch(`/api/tables/forms/${made.body.id}`, {
      revision: 1,
      config: { fields: [{ field_id: formula }] },
    });
    expect(computed).toMatchObject({ status: 400, body: { error: { details: { field: formula } } } });

    // A field made required after the form was saved is asked for too.
    const schema = (await as(lin).get(`/api/tables/bases/${table.base_id}`)).body.tables[0].schema_revision;
    await as(lin).patch(`/api/tables/fields/${primary.id}`, { schema_revision: schema, required: true });
    await as(lin).post(`/api/tables/forms/${made.body.id}/publish`);
    const fill = await as(lin).get(`/api/tables/forms/${made.body.id}/fill`);
    expect(fill.body.fields.map((field: any) => [field.id, field.required])).toEqual([
      [count.id, false],
      [due.id, true],
      [primary.id, true],
    ]);
  });

  it('deletes a form with its submissions and shares; the records stay', async () => {
    const s = await setup();
    const { lin, ann, app, as } = s;
    const { form, primary } = await published(s);
    await as(lin).put(`/api/tables/forms/${form.id}/share`, { items: [{ type: 'member', id: ann.id }] });
    const sent = await as(ann).post(`/api/tables/forms/${form.id}/submissions`, { values: { [primary.id]: 'Pens' } });
    expect(sent.status).toBe(201);
    const [submission] = await getDb()
      .select()
      .from(baseFormSubmissions)
      .where(eq(baseFormSubmissions.id, sent.body.id));
    expect((await as(lin).del(`/api/tables/forms/${form.id}`)).status).toBe(204);
    expect(await getDb().select().from(baseFormSubmissions).where(eq(baseFormSubmissions.formId, form.id))).toEqual([]);
    expect(await getDb().select().from(shares).where(eq(shares.resourceId, form.id))).toEqual([]);
    expect((await as(lin).get(`/api/tables/records/${submission!.recordId}`)).status).toBe(200);
    expect((await as(ann).get(`/api/tables/forms/${form.id}/fill`)).status).toBe(404);

    // Deleting a base or table for good drops the shares of its forms (service.ts calls this).
    const again = await published(s);
    await as(lin).put(`/api/tables/forms/${again.form.id}/share`, { items: [{ type: 'workspace' }] });
    await app.services.tables.forms.dropShares({ baseId: again.base.id });
    expect(await getDb().select().from(shares).where(eq(shares.resourceId, again.form.id))).toEqual([]);
  });
});

describe('who may submit', () => {
  it('is the members who may add records to the table, until the form has its own shares', async () => {
    const s = await setup();
    const { lin, mei, kai, ann, person, as } = s;
    const { form } = await published(s);
    const fill = (who: Who) => as(who).get(`/api/tables/forms/${form.id}/fill`);
    expect((await fill(mei)).status).toBe(200);
    expect((await fill(lin)).status).toBe(200);
    // A viewer and an outsider find no such form.
    expect((await fill(kai)).status).toBe(404);
    expect((await fill(ann)).status).toBe(404);
    expect((await as(ann).post(`/api/tables/forms/${form.id}/submissions`, { values: {} })).status).toBe(404);

    // Its own shares replace the default: Ann now, not Mei; builders always.
    const shared = await as(lin).put(`/api/tables/forms/${form.id}/share`, { items: [{ type: 'member', id: ann.id }] });
    expect(shared.body).toEqual({ items: [{ type: 'member', id: ann.id, name: 'Ann' }] });
    expect(await getDb().select({ role: shares.role }).from(shares).where(eq(shares.resourceId, form.id))).toEqual([
      { role: 'submitter' },
    ]);
    expect((await fill(ann)).status).toBe(200);
    expect((await fill(mei)).status).toBe(404);
    expect((await fill(lin)).status).toBe(200);
    // Only builders see or change who may submit.
    expect((await as(mei).get(`/api/tables/forms/${form.id}/share`)).status).toBe(404);
    expect((await as(ann).put(`/api/tables/forms/${form.id}/share`, { items: [] })).status).toBe(404);

    // Through a group, or everyone.
    const groupId = newId('group');
    await getDb().insert(groups).values({ id: groupId, name: 'Office' });
    await getDb().insert(groupMembers).values({ groupId, memberId: kai.id });
    await as(lin).put(`/api/tables/forms/${form.id}/share`, {
      items: [
        { type: 'member', id: ann.id },
        { type: 'group', id: groupId },
      ],
    });
    expect((await fill(kai)).status).toBe(200);
    const bo = await person('Bo');
    expect((await fill(bo)).status).toBe(404);
    const everyone = await as(lin).put(`/api/tables/forms/${form.id}/share`, { items: [{ type: 'workspace' }] });
    expect(everyone.body.items).toEqual([{ type: 'workspace', id: null, name: '' }]);
    expect((await fill(bo)).status).toBe(200);
    expect(
      (await as(lin).put(`/api/tables/forms/${form.id}/share`, { items: [{ type: 'member', id: 'mbr_nobody' }] }))
        .status,
    ).toBe(400);

    // A member whose tables module is off still fills in a form shared with them.
    await getDb()
      .update(members)
      .set({ modules: { tables: false } })
      .where(eq(members.id, bo.id));
    expect((await fill(bo)).status).toBe(200);
    // Back to the default: the table's editors.
    await as(lin).put(`/api/tables/forms/${form.id}/share`, { items: [] });
    expect((await fill(bo)).status).toBe(404);
    expect((await fill(mei)).status).toBe(200);
  });

  it('by default takes a custom role that edits the table, asking it only the fields it sees', async () => {
    const s = await setup();
    const { lin, mei, kai, as } = s;
    const { base, form, primary, count } = await published(s);
    const role = async (name: string, access: 'read' | 'edit') => {
      const id = newId('baseRole');
      await getDb()
        .insert(baseRoles)
        .values({
          id,
          baseId: base.id,
          name,
          rules: { tables: { [form.table_id]: { access, hidden_fields: [count.id] } } },
        });
      return id;
    };
    const helpers = await role('Helpers', 'edit');
    const readers = await role('Readers', 'read');
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [
        { type: 'member', id: mei.id, role: 'custom', custom_role_id: helpers },
        { type: 'member', id: kai.id, role: 'custom', custom_role_id: readers },
      ],
    });
    const fill = await as(mei).get(`/api/tables/forms/${form.id}/fill`);
    expect(fill.status).toBe(200);
    expect(fill.body.fields.map((field: any) => field.id)).not.toContain(count.id);
    const hidden = await as(mei).post(`/api/tables/forms/${form.id}/submissions`, {
      values: { [primary.id]: 'Chairs', [count.id]: 4 },
    });
    expect(hidden.body.error).toMatchObject({ code: 'invalid_input', details: { field: count.id } });
    expect(
      (await as(mei).post(`/api/tables/forms/${form.id}/submissions`, { values: { [primary.id]: 'Chairs' } })).status,
    ).toBe(201);
    // Reading the table is not adding to it.
    expect((await as(kai).get(`/api/tables/forms/${form.id}/fill`)).status).toBe(404);
    // Its submissions are for those who see every record.
    expect((await as(mei).get(`/api/tables/forms/${form.id}/submissions`)).status).toBe(404);
  });

  it('asks for links only of people who can read the linked table', async () => {
    const s = await setup();
    const { lin, mei, ann, as } = s;
    const { base, table, primary } = await requests(s);
    const projects = (await as(lin).post(`/api/tables/bases/${base.id}/tables`, { name: 'Projects' })).body;
    const project = (
      await as(lin).post(`/api/tables/tables/${table.id}/fields`, {
        name: 'Project',
        type: 'relation',
        config: { table_id: projects.id, multiple: false },
      })
    ).body;
    const target = (
      await as(lin).post(`/api/tables/tables/${projects.id}/records`, { values: { [projects.fields[0].id]: 'Move' } })
    ).body.record;
    const form = (
      await as(lin).post(`/api/tables/tables/${table.id}/forms`, {
        name: 'Linked',
        config: { fields: [{ field_id: primary.id }, { field_id: project.id }] },
      })
    ).body;
    await as(lin).post(`/api/tables/forms/${form.id}/publish`);
    await as(lin).put(`/api/tables/forms/${form.id}/share`, {
      items: [
        { type: 'member', id: mei.id },
        { type: 'member', id: ann.id },
      ],
    });
    const meis = (await as(mei).get(`/api/tables/forms/${form.id}/fill`)).body;
    expect(meis.fields.map((field: any) => field.id)).toEqual([primary.id, project.id]);
    expect(meis.fields[1].config).toEqual({ table_id: projects.id, multiple: false });
    const anns = (await as(ann).get(`/api/tables/forms/${form.id}/fill`)).body;
    expect(anns.fields.map((field: any) => field.id)).toEqual([primary.id]);
    expect(
      (
        await as(ann).post(`/api/tables/forms/${form.id}/submissions`, {
          values: { [primary.id]: 'Boxes', [project.id]: [target.id] },
        })
      ).body.error,
    ).toMatchObject({ code: 'invalid_input', details: { field: project.id } });
    const linked = await as(mei).post(`/api/tables/forms/${form.id}/submissions`, {
      values: { [primary.id]: 'Boxes', [project.id]: [target.id] },
    });
    expect(linked.status).toBe(201);
  });
});

describe('submitting', () => {
  it('adds a record as the submitter, named in its history as the form, with a file', async () => {
    const s = await setup();
    const { lin, ann, as, upload, listen } = s;
    const { form, primary, count, files, status } = await published(s);
    await as(lin).put(`/api/tables/forms/${form.id}/share`, { items: [{ type: 'member', id: ann.id }] });
    const fill = await as(ann).get(`/api/tables/forms/${form.id}/fill`);
    expect(fill.body).toMatchObject({
      name: 'Ask for supplies',
      description: 'What do you need?',
      status: 'published',
      success_message: 'Thanks, we will order it.',
      single_submit: false,
      submitted: false,
    });
    expect(fill.body.fields).toEqual([
      { id: primary.id, table_id: form.table_id, name: 'What', help: '', type: 'text', required: true, config: {} },
      {
        id: count.id,
        table_id: form.table_id,
        name: 'Count',
        help: 'How many',
        type: 'number',
        required: false,
        config: {},
      },
      {
        id: files.id,
        table_id: form.table_id,
        name: 'Files',
        help: '',
        type: 'attachment',
        required: false,
        config: {},
      },
    ]);

    const file = await upload(ann, form.id, 'list.txt');
    expect(file).toMatchObject({ status: 201, body: { name: 'list.txt', content_type: 'text/plain', size_bytes: 5 } });
    expect(file.body.url).toBeUndefined();

    // Required fields, and only the form's fields.
    const missing = await as(ann).post(`/api/tables/forms/${form.id}/submissions`, { values: { [count.id]: 2 } });
    expect(missing).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_input', details: { field: primary.id } } },
    });
    const extra = await as(ann).post(`/api/tables/forms/${form.id}/submissions`, {
      values: { [primary.id]: 'Pens', [status.id]: 'done' },
    });
    expect(extra.body.error.details).toEqual({ field: status.id });
    const wrong = await as(ann).post(`/api/tables/forms/${form.id}/submissions`, {
      values: { [primary.id]: 'Pens', [count.id]: 'many' },
    });
    expect(wrong.body.error.details).toEqual({ field: count.id });

    const told = listen(lin);
    const sent = await as(ann).post(`/api/tables/forms/${form.id}/submissions`, {
      values: { [primary.id]: 'Pens', [count.id]: 12, [files.id]: [file.body.id] },
    });
    expect(sent.status).toBe(201);
    expect(Object.keys(sent.body).sort()).toEqual(['created_at', 'id']);
    const [submission] = await getDb()
      .select()
      .from(baseFormSubmissions)
      .where(eq(baseFormSubmissions.id, sent.body.id));
    expect(submission).toMatchObject({ formId: form.id, memberId: ann.id, singleSubmit: false });
    const recordId = submission!.recordId!;
    expect(told.some((event) => event.type === 'records.changed')).toBe(true);

    const record = (await as(lin).get(`/api/tables/records/${recordId}`)).body;
    expect(record.record).toMatchObject({ created_by: ann.id, values: { [primary.id]: 'Pens', [count.id]: 12 } });
    expect(record.record.values[files.id]).toEqual([file.body.id]);
    expect(record.files[file.body.id]).toMatchObject({ name: 'list.txt' });
    const [event] = await getDb().select().from(baseRecordEvents).where(eq(baseRecordEvents.recordId, recordId));
    expect(event).toMatchObject({ actorType: 'form', actorId: ann.id, type: 'created', meta: { form_id: form.id } });
    const activity = await as(lin).get(`/api/tables/records/${recordId}/activity`);
    expect(activity.status).toBe(200);
    expect(activity.body.items[0]).toMatchObject({
      kind: 'event',
      type: 'created',
      actor: { type: 'form', id: ann.id, name: 'Ann' },
    });
    // Ann has no part in the base: she cannot read what she added.
    expect((await as(ann).get(`/api/tables/records/${recordId}`)).status).toBe(404);
    expect((await as(ann).get(`/api/tables/forms/${form.id}/fill`)).body.submitted).toBe(true);

    // A file attaches once, and only its uploader's.
    const again = await as(ann).post(`/api/tables/forms/${form.id}/submissions`, {
      values: { [primary.id]: 'More', [files.id]: [file.body.id] },
    });
    expect(again.status).toBe(400);
    const linsFile = await upload(lin, form.id);
    const notHers = await as(ann).post(`/api/tables/forms/${form.id}/submissions`, {
      values: { [primary.id]: 'More', [files.id]: [linsFile.body.id] },
    });
    expect(notHers.status).toBe(400);
    expect(await getDb().select().from(baseRecordFiles).where(eq(baseRecordFiles.fileId, linsFile.body.id))).toEqual(
      [],
    );
  });

  it('checks who may upload before reading the body, and caps what it reads', async () => {
    const s = await setup();
    const { app, ann, mei, as } = s;
    const { form, primary, table } = await published(s);
    const send = (who: Who, formId: string, size: number) => {
      const { body, type } = streamedUpload(size);
      return app.app.request(`/api/tables/forms/${formId}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${who.token}`, 'content-type': type },
        body,
        duplex: 'half',
      } as RequestInit);
    };
    // Ann may not submit: refused before a byte is read.
    expect((await send(ann, form.id, 51 * 1024 * 1024)).status).toBe(404);
    expect((await send(mei, form.id, 1024)).status).toBe(201);
    const huge = await send(mei, form.id, 51 * 1024 * 1024);
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as any).error.code).toBe('too_large');
    // A form without attachment fields takes no files.
    const plain = (
      await as(s.lin).post(`/api/tables/tables/${table.id}/forms`, {
        name: 'Plain',
        config: { fields: [{ field_id: primary.id }] },
      })
    ).body;
    await as(s.lin).post(`/api/tables/forms/${plain.id}/publish`);
    expect((await send(mei, plain.id, 1024)).status).toBe(400);
  });

  it('takes one submission per member from a single-submit form', async () => {
    const s = await setup();
    const { mei, lin, as, upload } = s;
    const { form, primary } = await published(s, { single_submit: true });
    const submit = (who: Who, title: string) =>
      as(who).post(`/api/tables/forms/${form.id}/submissions`, { values: { [primary.id]: title } });
    expect((await submit(mei, 'Chair')).status).toBe(201);
    expect(await submit(mei, 'Desk')).toMatchObject({ status: 409, body: { error: { code: 'already_submitted' } } });
    expect((await as(mei).get(`/api/tables/forms/${form.id}/fill`)).body).toMatchObject({
      single_submit: true,
      submitted: true,
    });
    expect((await upload(mei, form.id)).body.error.code).toBe('already_submitted');
    // Two at once: the partial unique index keeps one.
    const both = await Promise.all([submit(lin, 'Lamp'), submit(lin, 'Rug')]);
    expect(both.map((result) => result.status).sort()).toEqual([201, 409]);
    const rows = await getDb()
      .select()
      .from(baseFormSubmissions)
      .where(and(eq(baseFormSubmissions.formId, form.id), eq(baseFormSubmissions.memberId, lin.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.singleSubmit).toBe(true);
  });

  it('lists submissions newest first, with who, when and the record while it is there', async () => {
    const s = await setup();
    const { lin, mei, kai, ann, as } = s;
    const { form, primary } = await published(s);
    const submit = async (who: Who, title: string) =>
      (await as(who).post(`/api/tables/forms/${form.id}/submissions`, { values: { [primary.id]: title } })).body;
    const first = await submit(mei, 'Paper');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await submit(lin, 'Ink');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const third = await submit(mei, 'Tape');
    const page = await as(lin).get(`/api/tables/forms/${form.id}/submissions?limit=2`);
    expect(page.body.items.map((item: any) => [item.member?.name, item.record?.title])).toEqual([
      ['Mei', 'Tape'],
      ['Lin', 'Ink'],
    ]);
    expect(page.body.items[0].id).toBe(third.id);
    const next = await as(lin).get(`/api/tables/forms/${form.id}/submissions?limit=2&cursor=${page.body.next_cursor}`);
    expect(next.body).toMatchObject({ next_cursor: null, items: [{ id: first.id, member: { id: mei.id } }] });
    expect((await as(lin).get(`/api/tables/forms/${form.id}`)).body.submission_count).toBe(3);

    // A deleted record leaves the submission without one.
    const recordId = next.body.items[0].record.id;
    await as(lin).del(`/api/tables/records/${recordId}`);
    const after = await as(lin).get(`/api/tables/forms/${form.id}/submissions`);
    expect(after.body.items[2]).toMatchObject({ id: first.id, record: null });

    // Editors read them; viewers and submitters find no such form.
    expect((await as(mei).get(`/api/tables/forms/${form.id}/submissions`)).status).toBe(200);
    expect((await as(kai).get(`/api/tables/forms/${form.id}/submissions`)).status).toBe(404);
    await as(lin).put(`/api/tables/forms/${form.id}/share`, { items: [{ type: 'member', id: ann.id }] });
    expect((await as(ann).get(`/api/tables/forms/${form.id}/submissions`)).status).toBe(404);
  });
});

describe('client.tables.forms', () => {
  it('covers building, sharing, filling in, uploading, submitting and the submissions', async () => {
    const s = await setup();
    const { app } = s;
    const { table, primary, files } = await requests(s);
    const email = (await getDb().select({ email: members.email }).from(members).where(eq(members.id, s.lin.id)))[0]!
      .email;
    let stored: TokenPair | null = null;
    const client = createApiClient({
      baseUrl: '',
      tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
      fetch: (input, init) => Promise.resolve(app.app.request(String(input), init)),
    });
    await client.auth.login(email, TEST_PASSWORD);
    const { forms } = client.tables;
    const form = formSchema.parse(await forms.create(table.id, { name: 'Client' }));
    z.object({ items: z.array(formSchema) }).parse(await forms.list(table.id));
    formSchema.parse(await forms.get(form.id));
    const changed = formSchema.parse(
      await forms.update(form.id, {
        revision: form.revision,
        config: { fields: [{ field_id: primary.id, required: true }, { field_id: files.id }] },
      }),
    );
    formSchema.parse(await forms.publish(form.id));
    formSharesSchema.parse(await forms.share(form.id, { items: [{ type: 'workspace' }] }));
    formSharesSchema.parse(await forms.shares(form.id));
    const fill = formFillSchema.parse(await forms.fill(form.id));
    expect(fill.fields).toHaveLength(2);
    const file = formUploadSchema.parse(await forms.upload(form.id, new File(['x'], 'x.txt', { type: 'text/plain' })));
    formReceiptSchema.parse(await forms.submit(form.id, { [primary.id]: 'Hello', [files.id]: [file.id] }));
    const page = pageSchema(formSubmissionSchema).parse(await forms.submissions(form.id, { limit: 10 }));
    expect(page.items).toHaveLength(1);
    formSchema.parse(await forms.unpublish(form.id));
    await forms.remove(form.id);
    expect(changed.revision).toBe(2);
  });
});
