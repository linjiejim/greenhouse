/**
 * Built-in app templates and app plans, end to end over HTTP (Tables → Apps
 * Phase 1 slice AG, acceptance 6's deterministic part; real PostgreSQL, rolled
 * back per test):
 * - the catalog: every template drafts through the plan tool's validator with
 *   no problem and installs through the apply path with no failed operation —
 *   a new private Base the installer owns, disabled automations, one draft app
 *   whose spec has no problem against the Base it built;
 * - the procurement fixture as a confirmed CHAT plan (`/api/tables/schema-plan/apply`),
 *   shared and published in the same plan: 0 failed, published v1, audiences set;
 * - an app plan confirmed by a Base builder fails clearly on the owner's steps.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type {
  AppAudiencesView,
  AppDraftView,
  AppTemplateInstallResult,
  AppTemplateSummary,
} from '@greenhouse/types/apps';
import type { SchemaPlanApplyResult, SchemaPlanOperation } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import appRoutes from '../apps.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { APP_TEMPLATE_KEYS, appTemplates, findAppTemplate } from '../../platform/tables/app-templates/index.js';
import { draftTablesSchemaPlan } from '../../tools/tables-schema-plan.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let actionCounter = 0;

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
  app.route('/api/apps', appRoutes);
  return app;
}

let http: ReturnType<typeof createHttpApp>;

function send(user: UserRow, path: string, method = 'GET', body?: unknown) {
  return http.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.status, JSON.stringify(body).slice(0, 2000)).toBe(status);
  return body;
}

async function applyPlan(user: UserRow, operations: SchemaPlanOperation[]) {
  const sessionId = (await db.sessions.create('App plan', undefined, user.id, undefined, 'web')).id;
  return send(user, '/api/tables/schema-plan/apply', 'POST', {
    operations,
    action_id: `artifact:message-${++actionCounter}:1:tables_schema_plan`,
    session_id: sessionId,
  });
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  owner = await createInternalTestUser(db, { email: `ag-templates-owner-${Date.now()}@test.com`, nickname: 'Olive' });
  builder = await createInternalTestUser(db, { email: `ag-templates-builder-${Date.now()}@test.com`, nickname: 'Bo' });
  actionCounter = 0;
  initializePlatformRuntime(db, [tablesRegistration]);
  http = createHttpApp([owner, builder]);
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('built-in app templates', () => {
  it('lists every template in the viewer’s language', async () => {
    const english = await json<{ templates: AppTemplateSummary[] }>(await send(owner, '/api/apps/templates'));
    expect(english.templates.map((template) => template.key)).toEqual([...APP_TEMPLATE_KEYS]);
    expect(english.templates[0]).toMatchObject({ key: 'procurement', name: 'Purchase requests', icon: 'cart' });
    await db.users.update(owner.id, { locale: 'zh' });
    const chinese = await json<{ templates: AppTemplateSummary[] }>(await send(owner, '/api/apps/templates'));
    expect(chinese.templates.map((template) => template.name)).toEqual(['采购申请', 'IT 工单']);
  });

  it.each(APP_TEMPLATE_KEYS)('%s drafts with no problem and installs with no failed operation', async (key) => {
    const template = findAppTemplate(key)!;
    const drafted = await draftTablesSchemaPlan(owner.id, {
      summary: template.summary,
      operations: template.operations,
    });
    expect(drafted.ok ? [] : drafted.problems).toEqual([]);

    const installed = await json<AppTemplateInstallResult>(
      await send(owner, `/api/apps/templates/${key}/install`, 'POST'),
      201,
    );
    expect(installed.app).toMatchObject({
      status: 'draft',
      baseId: installed.baseId,
      canManage: true,
      canPublish: true,
    });
    const base = await db.tables.getBase(installed.baseId);
    expect(base).toMatchObject({ owner_id: owner.id, visibility: 'private' });

    // The installed draft has no problem against the Base the template built.
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${installed.app.id}/draft`));
    expect(draft.errors).toEqual([]);
    expect(draft.spec.roles.length).toBeGreaterThan(1);

    // Nothing runs and nobody else is reached until the owner decides.
    const rules = await db.tables.listAutomationRules(installed.baseId);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.status === 'disabled')).toBe(true);
    const audiences = await json<AppAudiencesView>(await send(owner, `/api/apps/${installed.app.id}/audiences`));
    expect(audiences.entries).toEqual([]);
  });

  it('answers 404 for an unknown template', async () => {
    expect((await send(owner, '/api/apps/templates/nope/install', 'POST')).status).toBe(404);
  });

  it('loads a catalog whose templates create no grants, forms, audiences or publishes', () => {
    for (const template of appTemplates().values()) {
      const kinds = new Set(template.operations.map((operation) => operation.op));
      for (const forbidden of ['member.set', 'role.create', 'form.create', 'app.audience', 'app.publish']) {
        expect(kinds.has(forbidden as SchemaPlanOperation['op']), `${template.key} ${forbidden}`).toBe(false);
      }
      expect(template.operations[0]!.op).toBe('base.create');
    }
  });
});

describe('the procurement app as a confirmed chat plan', () => {
  it('builds, shares and publishes it with 0 failed operations', async () => {
    const finance = await db.groups.create({ name: '财务', description: '', created_by: owner.id });
    const template = findAppTemplate('procurement')!;
    const operations: SchemaPlanOperation[] = [
      ...template.operations,
      {
        op: 'app.audience',
        appRef: template.appRef,
        entries: [
          { principal: { type: 'team' }, roleKey: 'applicant' },
          { principal: { type: 'group', groupId: finance.id }, roleKey: 'approver' },
        ],
      },
      { op: 'app.publish', appRef: template.appRef, notes: '第一版' },
    ];
    const drafted = await draftTablesSchemaPlan(owner.id, { summary: template.summary, operations });
    expect(drafted.ok ? [] : drafted.problems).toEqual([]);
    if (!drafted.ok) return;
    // The card's permission section names who gets what before Confirm.
    expect(drafted.artifact.accessChanges).toEqual([
      expect.objectContaining({
        kind: 'app_audience',
        app: '采购申请',
        before: null,
        after: [
          { principal: 'team', name: '', role: '申请人' },
          { principal: 'group', name: '财务', role: '审批人', managedBy: 'Olive' },
        ],
      }),
      expect.objectContaining({ kind: 'app_publish', app: '采购申请', version: 1 }),
    ]);

    const applied = await json<SchemaPlanApplyResult>(await applyPlan(owner, operations));
    expect(applied.results.filter((result) => result.status !== 'applied')).toEqual([]);
    const appId = applied.refs![template.appRef]!.id;
    const app = await db.tables.getApp(appId);
    expect(app).toMatchObject({ status: 'published', published_version: 1, base_id: applied.baseId });
    const audiences = await json<AppAudiencesView>(await send(owner, `/api/apps/${appId}/audiences`));
    expect(audiences.entries.map((entry) => [entry.principal.type, entry.roleKey])).toEqual([
      ['team', 'applicant'],
      ['group', 'approver'],
    ]);
    // The primary field was renamed and is what the form starts with.
    const tableId = applied.refs!.requests!.id;
    const schema = await db.tables.getSchema(tableId);
    expect(schema?.fields.find((field) => field.is_primary)?.name).toBe('申请事项');
  });

  it('lets a builder draft and build it, but the owner’s steps fail clearly when a builder confirms', async () => {
    const created = await json<{ base: { id: number }; schema: { table: { id: number } } }>(
      await send(owner, '/api/tables/bases', 'POST', { name: 'Purchasing' }),
      201,
    );
    await json(
      await send(owner, `/api/tables/bases/${created.base.id}/members/${builder.id}`, 'PUT', { role: 'builder' }),
    );
    const tableId = created.schema.table.id;
    const operations: SchemaPlanOperation[] = [
      { op: 'field.create', ref: 'amount', tableId, name: 'Amount', type: 'number' },
      {
        op: 'app.create',
        ref: 'desk',
        baseId: created.base.id,
        name: 'Requests',
        spec: {
          version: 1,
          pages: [
            {
              id: 'all',
              title: 'All',
              cards: [
                {
                  id: 'list',
                  kind: 'records',
                  layout: { x: 0, y: 0, w: 12, h: 6 },
                  source: { tableId },
                  fieldIds: ['$field:amount'],
                },
              ],
            },
          ],
          roles: [
            {
              key: 'member',
              name: 'Member',
              pages: 'all',
              tables: [{ tableId, access: 'read', fields: [], fieldDefault: 'visible' }],
            },
          ],
        },
      },
      { op: 'app.publish', appRef: 'desk', notes: 'v1' },
    ];
    // Drafting stops a builder at the owner's step, saying whose it is …
    const drafted = await draftTablesSchemaPlan(builder.id, { summary: 'Requests app', operations });
    expect(drafted.ok).toBe(false);
    expect(drafted.ok ? '' : drafted.problems.join('\n')).toMatch(/only the creator of Base .* can publish an app/);
    // … and a builder confirming it anyway gets the app built and the publish refused.
    const applied = await json<SchemaPlanApplyResult>(await applyPlan(builder, operations));
    expect(applied.results.map((result) => result.status)).toEqual(['applied', 'applied', 'failed']);
    expect(applied.results[2]!.message).toMatch(/Only the Base owner can publish/);
  });
});
