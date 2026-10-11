/**
 * Tables slice Fm: a double click on a single-submit form (spec
 * 20261011-tables-foundation §3, acceptance 5) — two concurrent submits by the
 * same person through the HTTP router create exactly one record.
 *
 * @db-commit-reason The two submits must race on `uq_table_form_submissions_single`
 * from independent connections; inside the rollback-wrapped suite every call
 * shares one connection, so the second insert never waits on the first's
 * uncommitted row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { isUniqueViolation } from '@greenhouse/utils/error';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import formRoutes from '../forms.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { formSubmitScope } from '../../platform/tables/form-access.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
const userIds: string[] = [];
const baseIds: number[] = [];

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

describe('Tables forms — concurrent single submission', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterAll(async () => {
    for (const baseId of baseIds) await db.executeRaw(sql`DELETE FROM table_bases WHERE id = ${baseId}`);
    for (const userId of userIds) await db.users.delete(userId);
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('turns a double click into one record and one already_submitted', async () => {
    const owner = await createInternalTestUser(db, { email: `${unique('fm-race-owner')}@test.local` });
    const submitter = await createInternalTestUser(db, { email: `${unique('fm-race-submitter')}@test.local` });
    userIds.push(owner.id, submitter.id);
    const app = createHttpApp([owner, submitter]);
    const send = (user: UserRow, path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': user.id },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const created = (await (await send(owner, '/api/tables/bases', 'POST', { name: unique('Race') })).json()) as {
      base: { id: number };
      schema: { table: { id: number }; fields: Array<{ id: number }> };
    };
    baseIds.push(created.base.id);
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    const formResponse = await send(owner, `/api/tables/tables/${tableId}/forms`, 'POST', {
      name: 'Once',
      status: 'published',
      audience: { type: 'team' },
      config: { fieldIds: [primaryId], allowMultiple: false },
    });
    expect(formResponse.status).toBe(201);
    const formId = ((await formResponse.json()) as { form: { id: number } }).form.id;

    const submit = (label: string) =>
      send(submitter, `/api/forms/${formId}/submit`, 'POST', { values: { [primaryId]: label } });
    const responses = await Promise.all([submit('First click'), submit('Second click')]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const refused = responses.find((response) => response.status === 409)!;
    expect(await refused.json()).toMatchObject({ details: { reason: 'already_submitted' } });

    const rows = await db.executeRaw(
      sql`SELECT count(*)::int AS n FROM table_records WHERE table_id = ${tableId} AND deleted_at IS NULL`,
    );
    expect((rows[0] as { n: number }).n).toBe(1);
    const submissions = await db.executeRaw(
      sql`SELECT count(*)::int AS n FROM table_form_submissions WHERE form_id = ${formId}`,
    );
    expect((submissions[0] as { n: number }).n).toBe(1);

    // Below the route's pre-check: two writes that both start before either
    // commits are decided by the partial unique index alone.
    const other = await createInternalTestUser(db, { email: `${unique('fm-race-other')}@test.local` });
    userIds.push(other.id);
    const form = (await db.tables.getForm(formId))!;
    const write = (label: string) =>
      db.tables.submitForm(formId, { [primaryId]: label }, formSubmitScope(form, other.id), {
        actorId: other.id,
        actorKind: 'form',
        source: { formId },
        enqueueAutomations: false,
      });
    const settled = await Promise.allSettled([write('A'), write('B')]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(isUniqueViolation(rejected[0]!.reason)).toBe(true);
  });
});
