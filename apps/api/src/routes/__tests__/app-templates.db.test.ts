/**
 * Built-in app templates and app plans, end to end over HTTP (Tables → Apps
 * Phase 1 slice AG, acceptance 6's deterministic part; real PostgreSQL, rolled
 * back per test):
 * - the catalog: every template, in each of its languages, drafts through the
 *   plan tool's validator with no problem and installs through the apply path
 *   with no failed operation — a new private Base the installer owns, disabled
 *   automations, one draft app whose spec has no problem against the Base it
 *   built — in the language the center lists it in (the installer's);
 * - the procurement fixture as a confirmed CHAT plan (`/api/tables/schema-plan/apply`),
 *   shared and published in the same plan: 0 failed, published v1, audiences set;
 * - an app plan confirmed by a Base builder fails clearly on the owner's steps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type {
  AppAudiencesView,
  AppDraftView,
  AppTemplateInstallResult,
  AppTemplateDetailView,
  AppTemplateSummary,
} from '@greenhouse/types/apps';
import type { SchemaPlanApplyResult, SchemaPlanOperation } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import appRoutes from '../apps.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import {
  APP_TEMPLATE_KEYS,
  APP_TEMPLATE_LOCALES,
  appTemplates,
  findAppTemplate,
} from '../../platform/tables/app-templates/index.js';
import { draftTablesSchemaPlan } from '../../tools/tables-schema-plan.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let actionCounter = 0;
// Each install dispatches dozens of real schema actions; allow slow local/CI PostgreSQL runs.
vi.setConfig({ testTimeout: 30_000 });

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
    expect(chinese.templates.map((template) => template.name)).toEqual(['采购申请', 'IT 工单', '轻量 CRM', '招聘流程']);
  });

  const cases = APP_TEMPLATE_KEYS.flatMap((key) => APP_TEMPLATE_LOCALES.map((locale) => [key, locale] as const));
  it.each(cases)('%s (%s) drafts with no problem and installs with no failed operation', async (key, locale) => {
    const template = findAppTemplate(key)!;
    const plan = template.plans[locale];
    const drafted = await draftTablesSchemaPlan(owner.id, { summary: plan.summary, operations: plan.operations });
    expect(drafted.ok ? [] : drafted.problems).toEqual([]);

    await db.users.update(owner.id, { locale });
    const listed = await json<{ templates: AppTemplateSummary[] }>(await send(owner, '/api/apps/templates'));
    const installed = await json<AppTemplateInstallResult>(
      await send(owner, `/api/apps/templates/${key}/install`, 'POST'),
      201,
    );
    // Installed in the language it was listed in: the Base, its fields and the app all read in it.
    const name = listed.templates.find((entry) => entry.key === key)!.name;
    expect(installed.app.name).toBe(name);
    const built = await db.tables.getBase(installed.baseId);
    expect(built?.name).toBe(name);
    const tables = await db.tables.listTables(installed.baseId);
    const words = JSON.stringify({
      tables: tables.map((table) => table.name),
      fields: await Promise.all(tables.map(async (table) => (await db.tables.getSchema(table.id))?.fields)),
      rules: (await db.tables.listAutomationRules(installed.baseId)).map((rule) => [rule.name, rule.config]),
    });
    const chinese = /[\u3000-\u9fff]/;
    expect(chinese.test(words), words.slice(0, 300)).toBe(locale === 'zh');
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
    expect(draft.spec.roles.length).toBeGreaterThan(0);
    expect(chinese.test(JSON.stringify(draft.spec))).toBe(locale === 'zh');

    // Nothing runs and nobody else is reached until the owner decides.
    const rules = await db.tables.listAutomationRules(installed.baseId);
    expect(rules.length).toBe(template.plans[locale].operations.filter((op) => op.op === 'automation.create').length);
    expect(rules.every((rule) => rule.status === 'disabled')).toBe(true);
    const audiences = await json<AppAudiencesView>(await send(owner, `/api/apps/${installed.app.id}/audiences`));
    expect(audiences.entries).toEqual([]);
  });

  it('answers 404 for an unknown template', async () => {
    expect((await send(owner, '/api/apps/templates/nope/install', 'POST')).status).toBe(404);
  });

  it('loads a catalog whose templates create no grants, forms, audiences or publishes', () => {
    for (const template of appTemplates().values()) {
      for (const plan of Object.values(template.plans)) {
        const kinds = new Set(plan.operations.map((operation) => operation.op));
        for (const forbidden of ['member.set', 'role.create', 'form.create', 'app.audience', 'app.publish']) {
          expect(kinds.has(forbidden as SchemaPlanOperation['op']), `${template.key} ${forbidden}`).toBe(false);
        }
        expect(plan.operations[0]!.op).toBe('base.create');
      }
      // One structure in every language (both come from the same file): the same steps, the same refs.
      const steps = (operations: SchemaPlanOperation[]) =>
        operations.map((operation) => `${operation.op}:${'ref' in operation ? operation.ref : ''}`);
      expect(steps(template.plans.en.operations)).toEqual(steps(template.plans.zh.operations));
    }
  });
});

describe('the procurement app as a confirmed chat plan', () => {
  it('builds, shares and publishes it with 0 failed operations', async () => {
    const finance = await db.groups.create({ name: '财务', description: '', created_by: owner.id });
    const template = findAppTemplate('procurement')!;
    const plan = template.plans.zh;
    const operations: SchemaPlanOperation[] = [
      ...plan.operations,
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
    const drafted = await draftTablesSchemaPlan(owner.id, { summary: plan.summary, operations });
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

describe('published template lifecycle', () => {
  async function source() {
    return json<AppTemplateInstallResult>(await send(owner, '/api/apps/templates/crm/install', 'POST'), 201);
  }
  async function publish(appId: number, extra: Record<string, unknown> = {}) {
    return send(owner, '/api/apps/templates', 'POST', { appId, key: 'my-crm', version: '1.0.0', ...extra });
  }
  it('exports structure without live records, installs explicit samples and keeps versions immutable', async () => {
    const original = await source();
    const [table] = await db.tables.listTables(original.baseId);
    const fields = await db.tables.listFields(table!.id);
    const primary = fields.find((field) => field.is_primary)!;
    expect(
      (
        await publish(original.app.id, {
          sampleRecords: [{ tableId: table!.id, values: [{ fieldId: primary.id, value: 12 }] }],
        })
      ).status,
    ).toBe(400);
    await json(
      await send(owner, `/api/tables/tables/${table!.id}/records`, 'POST', {
        values: { [primary.id]: 'PRIVATE LIVE RECORD' },
      }),
      201,
    );
    const published = await json<AppTemplateDetailView>(
      await publish(original.app.id, {
        sampleRecords: [{ tableId: table!.id, values: [{ fieldId: primary.id, value: 'Handwritten example' }] }],
      }),
      201,
    );
    expect(published.template.reviewStatus).toBe('not_required');
    expect(published.review?.content).not.toContain('PRIVATE LIVE RECORD');
    const installed = await json<AppTemplateInstallResult>(
      await send(builder, '/api/apps/templates/my-crm/install', 'POST', { name: 'My CRM copy' }),
      201,
    );
    expect(installed.baseId).not.toBe(original.baseId);
    expect(installed.app.name).toBe('My CRM copy');
    expect((await db.tables.getBase(installed.baseId))?.name).toBe('My CRM copy');
    expect((await db.tables.getBase(installed.baseId))?.owner_id).toBe(builder.id);
    const [copy] = await db.tables.listTables(installed.baseId);
    const rows = await json<{ records: Array<{ values: unknown }> }>(
      await send(builder, `/api/tables/tables/${copy!.id}/records/query`, 'POST', {}),
    );
    expect(JSON.stringify(rows)).toContain('Handwritten example');
    expect(JSON.stringify(rows)).not.toContain('PRIVATE LIVE RECORD');
    const outsider = await json<AppTemplateDetailView>(await send(builder, '/api/apps/templates/my-crm'));
    expect(outsider.review).toBeUndefined();
    expect(outsider.template.canManage).toBe(false);
    expect((await publish(original.app.id)).status).toBe(400);
    expect((await publish(original.app.id, { version: '1.1.0' })).status).toBe(400);
    const next = await json<AppTemplateDetailView>(
      await publish(original.app.id, { version: '1.1.0', changelog: 'More examples' }),
      201,
    );
    expect(next.versions).toHaveLength(2);
    expect(next.versions.find((version) => version.version === '1.0.0')?.contentHash).toBe(
      published.versions[0]?.contentHash,
    );
    expect((await send(builder, '/api/apps/templates/my-crm/archive', 'POST')).status).toBe(403);
    await json(await send(owner, '/api/apps/templates/my-crm/archive', 'POST'));
    expect((await send(owner, '/api/apps/templates/my-crm/install', 'POST')).status).toBe(404);
  });
  it('holds automations for a super review, sanitizes fixed recipients, and installs with the installer as executor', async () => {
    const original = await json<AppTemplateInstallResult>(
      await send(owner, '/api/apps/templates/it-tickets/install', 'POST'),
      201,
    );
    const rules = await db.tables.listAutomationRules(original.baseId);
    const sourceRule = rules[0]!;
    const config = {
      ...sourceRule.config,
      actions: sourceRule.config.actions.map((action) =>
        action.type === 'notify' ? { ...action, recipients: { creator: true, userIds: [owner.id] } } : action,
      ),
    };
    await json(
      await send(owner, `/api/tables/automations/${sourceRule.id}`, 'PATCH', { revision: sourceRule.revision, config }),
    );
    const published = await json<AppTemplateDetailView>(await publish(original.app.id), 201);
    expect(published.template.reviewStatus).toBe('pending');
    expect(published.review?.content).not.toContain(owner.id);
    expect((await send(builder, '/api/apps/templates/my-crm')).status).toBe(404);
    expect((await send(owner, '/api/apps/templates/my-crm/install', 'POST')).status).toBe(403);
    expect(
      (await send(owner, '/api/apps/templates/my-crm/versions/1.0.0/review', 'POST', { decision: 'approve' })).status,
    ).toBe(403);
    const admin = await createInternalTestUser(db, {
      email: `template-reviewer-${Date.now()}@test.com`,
      role: 'super',
    });
    http = createHttpApp([owner, builder, admin]);
    await json(
      await send(admin, '/api/apps/templates/my-crm/versions/1.0.0/review', 'POST', {
        decision: 'approve',
        note: 'Reviewed exact content',
      }),
    );
    const installed = await json<AppTemplateInstallResult>(
      await send(builder, '/api/apps/templates/my-crm/install', 'POST'),
      201,
    );
    const installedRules = await db.tables.listAutomationRules(installed.baseId);
    expect(installedRules.length).toBe(rules.length);
    for (const rule of installedRules) {
      expect(rule.status).toBe('disabled');
      expect(rule.execution_user_id).toBe(builder.id);
    }
    await json(await send(admin, '/api/apps/templates/my-crm/versions/1.0.0/review', 'POST', { decision: 'reject' }));
    expect((await send(builder, '/api/apps/templates/my-crm/install', 'POST')).status).toBe(403);
  });
  it('refuses another builder’s private app and reserved builtin keys', async () => {
    const original = await source();
    expect(
      (await send(builder, '/api/apps/templates', 'POST', { appId: original.app.id, key: 'stolen', version: '1.0.0' }))
        .status,
    ).toBe(404);
    expect((await publish(original.app.id, { key: 'procurement' })).status).toBe(403);
  });
});
