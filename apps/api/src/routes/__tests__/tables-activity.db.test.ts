/**
 * Tables record activity and comments over HTTP (slice C, real PostgreSQL):
 * the merged feed and its viewer flags, who may comment / edit / delete, 404
 * for everything outside the caller's reach, the masked-values ceiling, the
 * kernel `comment` entity ceiling, and @mention notifications — only to
 * people who can read the record, once per comment × person.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { FieldPolicy } from '@greenhouse/platform-kernel';
import type {
  TableBaseRole,
  TableRecordActivityPage,
  TableRecordCommentView,
  TableRecordEventView,
} from '@greenhouse/types/tables';
import { mentionMarkdown } from '@greenhouse/utils/mentions';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import { tablesManifest } from '../../platform/manifests/tables.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { mentionPreview, notifyCommentMentions } from '../../platform/tables/mentions.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let editor: UserRow;
let viewer: UserRow;
let outsider: UserRow;

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

interface Workspace {
  app: App;
  baseId: number;
  tableId: number;
  primaryId: number;
  recordId: number;
  revision: number;
}

async function workspace(): Promise<Workspace> {
  const app = createHttpApp([owner, editor, viewer, outsider]);
  const created = await send(app, owner, '/api/tables/bases', 'POST', { name: 'Activity Base' });
  expect(created.status).toBe(201);
  const { base, schema } = (await created.json()) as {
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  };
  const addMember = async (user: UserRow, role: TableBaseRole) =>
    expect((await send(app, owner, `/api/tables/bases/${base.id}/members/${user.id}`, 'PUT', { role })).status).toBe(
      200,
    );
  await addMember(editor, 'editor');
  await addMember(viewer, 'viewer');
  const primaryId = schema.fields[0]!.id;
  const record = await send(app, owner, `/api/tables/tables/${schema.table.id}/records`, 'POST', {
    values: { [primaryId]: 'Acme' },
  });
  expect(record.status).toBe(201);
  const { record: row } = (await record.json()) as { record: { id: number; revision: number } };
  return { app, baseId: base.id, tableId: schema.table.id, primaryId, recordId: row.id, revision: row.revision };
}

const activityPath = (w: Workspace) => `/api/tables/tables/${w.tableId}/records/${w.recordId}/activity`;
const commentsPath = (w: Workspace) => `/api/tables/tables/${w.tableId}/records/${w.recordId}/comments`;

async function postComment(w: Workspace, user: UserRow, body: string): Promise<TableRecordCommentView> {
  const response = await send(w.app, user, commentsPath(w), 'POST', { body });
  expect(response.status).toBe(201);
  return ((await response.json()) as { comment: TableRecordCommentView }).comment;
}

async function activity(w: Workspace, user: UserRow, query = ''): Promise<TableRecordActivityPage> {
  const response = await send(w.app, user, `${activityPath(w)}${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as TableRecordActivityPage;
}

async function mentionsFor(user: UserRow) {
  const { items } = await db.notifications.listForUser({ user_id: user.id, limit: 100 });
  return items.filter((item) => item.kind === 'tables_mention');
}

async function maskValues(user: UserRow) {
  const fields = Object.fromEntries(
    Object.keys(tablesManifest.entities.record!.fields).map((fieldId) => [
      fieldId,
      { read: fieldId === 'values' ? 'masked' : 'full', write: false, export: false } satisfies FieldPolicy,
    ]),
  );
  await db.platform.setUserEntityPolicyOverride({
    org_id: 'default',
    user_id: user.id,
    effect: 'allow',
    policy: {
      app_id: 'tables',
      module_id: 'data',
      entity_id: 'record',
      scopes: [{ kind: 'all' }],
      field_policies: fields,
    },
    granted_by: owner.id,
  });
}

describe('Tables record activity and comments — API', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    [owner, editor, viewer, outsider] = await Promise.all([
      createInternalTestUser(db, { email: 'tables-act-owner@test.com', nickname: 'Olive' }),
      createInternalTestUser(db, { email: 'tables-act-editor@test.com', nickname: 'Eddie' }),
      createInternalTestUser(db, { email: 'tables-act-viewer@test.com', nickname: 'Vera' }),
      createInternalTestUser(db, { email: 'tables-act-outsider@test.com', nickname: 'Otto' }),
    ]);
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('merges comments with history and tells the caller what it may do', async () => {
    const w = await workspace();
    const updated = await send(w.app, editor, `/api/tables/tables/${w.tableId}/records/${w.recordId}`, 'PATCH', {
      revision: w.revision,
      values: { [w.primaryId]: 'Acme Ltd' },
    });
    expect(updated.status).toBe(200);
    // History and comments are stamped in milliseconds; land on a later instant.
    await new Promise((resolve) => setTimeout(resolve, 3));
    await postComment(w, viewer, 'Looks good');

    const page = await activity(w, viewer);
    expect(page.items.map((item) => item.kind)).toEqual(['comment', 'event', 'event']);
    const [comment, update, created] = page.items as [
      TableRecordCommentView,
      TableRecordEventView,
      TableRecordEventView,
    ];
    expect(comment).toMatchObject({ authorId: viewer.id, body: 'Looks good', edited: false });
    expect(update).toMatchObject({
      type: 'updated',
      actorId: editor.id,
      actorKind: 'user',
      changes: [{ fieldId: w.primaryId, before: 'Acme', after: 'Acme Ltd' }],
    });
    expect(created).toMatchObject({ type: 'created', actorId: owner.id });
    expect(page.viewer).toEqual({ userId: viewer.id, canComment: true, canModerate: false });
    expect((await activity(w, owner)).viewer).toMatchObject({ canComment: true, canModerate: true });

    // Paging through the HTTP cursor.
    const first = await activity(w, owner, '?limit=2');
    expect(first.items).toHaveLength(2);
    const rest = await activity(w, owner, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(rest.items.map((item) => item.kind)).toEqual(['event']);
    expect(rest.nextCursor).toBeNull();
    expect((await send(w.app, owner, `${activityPath(w)}?cursor=forged`)).status).toBe(400);
  });

  it('answers 404 to everyone outside the record, for every path', async () => {
    const w = await workspace();
    const comment = await postComment(w, owner, 'internal');
    expect((await send(w.app, outsider, activityPath(w))).status).toBe(404);
    expect((await send(w.app, outsider, commentsPath(w), 'POST', { body: 'hi' })).status).toBe(404);
    expect((await send(w.app, outsider, `/api/tables/comments/${comment.id}`, 'PATCH', { body: 'x' })).status).toBe(
      404,
    );
    expect((await send(w.app, outsider, `/api/tables/comments/${comment.id}`, 'DELETE')).status).toBe(404);
    // An id on another table's record is not reachable through this table either.
    expect(
      (await send(w.app, owner, `/api/tables/tables/${w.tableId}/records/${w.recordId + 100_000}/activity`)).status,
    ).toBe(404);
  });

  it('lets the author edit, the author or a builder delete, and nobody else', async () => {
    const w = await workspace();
    const mine = await postComment(w, viewer, 'from the viewer');
    const path = `/api/tables/comments/${mine.id}`;

    expect((await send(w.app, editor, path, 'PATCH', { body: 'hijack' })).status).toBe(403);
    expect((await send(w.app, owner, path, 'PATCH', { body: 'owner rewrite' })).status).toBe(403);
    const edited = await send(w.app, viewer, path, 'PATCH', { body: 'from the viewer, edited' });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { comment: TableRecordCommentView }).comment).toMatchObject({
      body: 'from the viewer, edited',
      edited: true,
    });
    expect((await send(w.app, viewer, path, 'PATCH', { body: '   ' })).status).toBe(400);

    expect((await send(w.app, editor, path, 'DELETE')).status).toBe(403);
    expect((await send(w.app, owner, path, 'DELETE')).status).toBe(200);
    expect((await send(w.app, owner, path, 'DELETE')).status).toBe(404);

    const own = await postComment(w, editor, 'editor note');
    expect((await send(w.app, editor, `/api/tables/comments/${own.id}`, 'DELETE')).status).toBe(200);
    expect((await activity(w, owner)).items.filter((item) => item.kind === 'comment')).toEqual([]);
  });

  it('shows a masked reader who and when, never a value, and still lets them comment', async () => {
    const w = await workspace();
    await maskValues(viewer);
    const page = await activity(w, viewer);
    expect(page.items).toEqual([expect.objectContaining({ kind: 'event', type: 'created', changes: [] })]);
    expect(JSON.stringify(page)).not.toContain('Acme');
    await postComment(w, viewer, 'cannot see the values, can still talk');
  });

  it('honours a kernel denial of the comment entity', async () => {
    const w = await workspace();
    await postComment(w, owner, 'existing');
    await db.platform.setUserEntityPolicyOverride({
      org_id: 'default',
      user_id: editor.id,
      effect: 'deny',
      policy: { app_id: 'tables', module_id: 'data', entity_id: 'comment', scopes: [], field_policies: {} },
      granted_by: owner.id,
    });
    const page = await activity(w, editor);
    expect(page.viewer).toMatchObject({ canComment: false, canModerate: false });
    expect(page.items.every((item) => item.kind === 'event')).toBe(true);
    expect((await send(w.app, editor, commentsPath(w), 'POST', { body: 'hi' })).status).toBe(403);
  });

  it('notifies mentioned readers only, once per comment and person, with a link to the record', async () => {
    const w = await workspace();
    const body = [
      mentionMarkdown('Eddie', editor.id),
      mentionMarkdown('Otto', outsider.id), // not a Base member → skipped silently
      mentionMarkdown('Olive', owner.id), // the author → never notified
      mentionMarkdown('Ghost', 'no-such-user'),
      'please check the **amount**',
    ].join(' ');
    const comment = await postComment(w, owner, body);
    expect(comment.mentions).toEqual([editor.id, outsider.id, owner.id]);

    const [notice] = await mentionsFor(editor);
    expect(notice).toMatchObject({
      kind: 'tables_mention',
      dedupe_key: `tables-mention:${comment.id}:${editor.id}`,
      body: '@Eddie @Otto @Olive @Ghost please check the **amount**',
    });
    expect(notice!.title).toContain('Olive');
    expect(JSON.parse(notice!.payload)).toMatchObject({
      href: `#/tables/${w.baseId}/table/${w.tableId}?record=${w.recordId}`,
      baseId: w.baseId,
      tableId: w.tableId,
      recordId: w.recordId,
      commentId: comment.id,
    });
    expect(await mentionsFor(outsider)).toEqual([]);
    expect(await mentionsFor(owner)).toEqual([]);

    // An edit only tells the people it adds.
    const edited = await send(w.app, owner, `/api/tables/comments/${comment.id}`, 'PATCH', {
      body: `${body} ${mentionMarkdown('Vera', viewer.id)}`,
    });
    expect(edited.status).toBe(200);
    expect(await mentionsFor(viewer)).toHaveLength(1);
    expect(await mentionsFor(editor)).toHaveLength(1);

    // A replay of the same comment × person is the same fact.
    const again = await notifyCommentMentions(
      { db },
      {
        base: { id: w.baseId },
        tableId: w.tableId,
        recordId: w.recordId,
        comment: { id: comment.id, body },
        authorId: owner.id,
        userIds: [editor.id],
      },
    );
    expect(again).toEqual([editor.id]);
    expect(await mentionsFor(editor)).toHaveLength(1);
  });
});

describe('mentionPreview', () => {
  it('flattens whitespace, renders mentions as names and caps the length', () => {
    expect(mentionPreview(`hi ${mentionMarkdown('Ann', 'u-1')}\n\n  there`)).toBe('hi @Ann there');
    const long = mentionPreview('x'.repeat(400));
    expect(long).toHaveLength(280);
    expect(long.endsWith('…')).toBe(true);
  });
});
