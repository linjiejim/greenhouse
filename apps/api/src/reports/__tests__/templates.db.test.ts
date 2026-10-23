/**
 * Report templates on the real database, through the real /api/report-templates
 * route: any member publishes a team template or keeps a draft; everyone sees
 * team templates; a draft is its owner's alone; a team template is changed by
 * its owner or a super; deletes are soft; the shipped templates are seeded
 * once and a deleted one stays deleted; the preview renders a PDF.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { initDatabase, _resetProvider, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { ReportTemplateView } from '@greenhouse/types/reports';
import reportTemplateRoutes from '../../routes/report-templates.js';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { DEFAULT_REPORT_TEMPLATES, seedDefaultReportTemplates } from '../defaults.js';
import { listActivity } from '../../activity/activity-log.js';

vi.setConfig({ testTimeout: 20_000 });

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;
let admin: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function as(user: UserRow) {
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: user.id, role: user.role, email: user.email, name: 'Test' } as never);
      await next();
    })
    .route('/api/report-templates', reportTemplateRoutes);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/report-templates${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    list: async () => ((await (await send('GET', '')).json()) as { templates: ReportTemplateView[] }).templates,
    get: (id: string) => send('GET', `/${id}`),
    create: (body: unknown) => send('POST', '', body),
    update: (id: string, body: unknown) => send('PUT', `/${id}`, body),
    remove: (id: string) => send('DELETE', `/${id}`),
    preview: (body: unknown) => send('POST', '/preview', body),
  };
}

function definition(name: string, visibility: 'team' | 'personal' = 'team') {
  return {
    name,
    description: 'Status',
    kind: 'report',
    formats: ['pdf'],
    visibility,
    cover_fields: [{ key: 'title', required: true }],
    sections: [{ key: 'summary', title: '摘要', guidance: 'Say it.', required: true, content: 'markdown' }],
  };
}

async function created(response: Response): Promise<ReportTemplateView> {
  expect(response.status).toBe(201);
  return ((await response.json()) as { template: ReportTemplateView }).template;
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  alice = await createInternalTestUser(db, { email: `${unique('rt-alice')}@test.local` });
  bob = await createInternalTestUser(db, { email: `${unique('rt-bob')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('rt-admin')}@test.local`, role: 'super' });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('report templates: rights', () => {
  it('lets any member publish a team template that everyone sees but only the owner or a super changes', async () => {
    const name = unique('Weekly');
    const template = await created(await as(alice).create(definition(name)));
    expect(template).toMatchObject({ name, visibility: 'team', owner_user_id: alice.id, version: 1, can_edit: true });

    const seenByBob = (await as(bob).list()).find((t) => t.id === template.id);
    expect(seenByBob).toMatchObject({ name, can_edit: false });
    expect((await as(bob).update(template.id, definition('Hijack'))).status).toBe(403);
    expect((await as(bob).remove(template.id)).status).toBe(403);

    const edited = await as(admin).update(template.id, { ...definition(`${name} v2`), description: 'Edited' });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { template: ReportTemplateView }).template).toMatchObject({
      name: `${name} v2`,
      description: 'Edited',
      version: 2,
      owner_user_id: alice.id,
    });

    expect((await as(alice).remove(template.id)).status).toBe(200);
    expect((await as(bob).get(template.id)).status).toBe(404);
    expect((await as(alice).list()).some((t) => t.id === template.id)).toBe(false);
  });

  it('keeps a draft to its owner — not even a super sees it — until it is published', async () => {
    const draft = await created(await as(alice).create(definition(unique('Draft'), 'personal')));
    expect((await as(bob).list()).some((t) => t.id === draft.id)).toBe(false);
    expect((await as(admin).get(draft.id)).status).toBe(404);
    expect((await as(admin).update(draft.id, definition('x'))).status).toBe(404);

    const published = await as(alice).update(draft.id, definition(draft.name, 'team'));
    expect(published.status).toBe(200);
    expect((await as(bob).list()).some((t) => t.id === draft.id)).toBe(true);
  });

  it('refuses a malformed definition with every problem listed', async () => {
    const response = await as(alice).create({
      ...definition('Bad'),
      formats: ['pptx'],
      sections: [{ key: 'Bad', title: '', content: 'markdown' }],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; errors: string[] };
    expect(body.errors).toHaveLength(3);
    expect(body.error).toBe(body.errors[0]);
  });
});

describe('report templates: shipped defaults', () => {
  async function liveDefaults() {
    return (await db.executeRaw(
      sql`SELECT id, name, owner_user_id, visibility, is_default FROM report_templates WHERE is_default AND deleted_at IS NULL`,
    )) as Array<{ id: string; name: string; owner_user_id: string | null; visibility: string }>;
  }

  it('seeds the weekly report and the project review deck once, editable by a super only', async () => {
    const before = (await db.executeRaw(sql`SELECT count(*)::int AS n FROM report_templates`)) as Array<{ n: number }>;
    if (before[0]!.n > 0) return; // another run committed templates; the seed is a no-op by design
    expect(await seedDefaultReportTemplates(db)).toBe(2);
    expect(await seedDefaultReportTemplates(db)).toBe(0);
    const seeded = await liveDefaults();
    expect(seeded.map((row) => row.name).sort()).toEqual(DEFAULT_REPORT_TEMPLATES.map((t) => t.name).sort());
    expect(seeded.every((row) => row.owner_user_id === null && row.visibility === 'team')).toBe(true);

    const weekly = (await as(bob).list()).find((t) => t.name === '周报 Weekly report')!;
    expect(weekly).toMatchObject({ is_default: true, can_edit: false, kind: 'report', formats: ['pdf', 'docx'] });
    expect(weekly.sections.map((s) => s.key)).toEqual(['summary', 'metrics', 'progress', 'risks', 'next_week', 'asks']);
    expect((await as(admin).list()).find((t) => t.id === weekly.id)!.can_edit).toBe(true);
    // A shipped template cannot be turned into an (ownerless, invisible) draft.
    expect((await as(admin).update(weekly.id, { ...weekly, visibility: 'personal' })).status).toBe(400);

    // Deleted defaults stay deleted: the seed only runs while there has never been a template.
    expect((await as(admin).remove(weekly.id)).status).toBe(200);
    expect(await seedDefaultReportTemplates(db)).toBe(0);
    expect((await liveDefaults()).some((row) => row.id === weekly.id)).toBe(false);
  });

  it('does not seed a workspace that already has a template', async () => {
    await created(await as(alice).create(definition(unique('Ours'))));
    expect(await seedDefaultReportTemplates(db)).toBe(0);
  });
});

describe('report templates: preview', () => {
  it('renders an unsaved definition and a saved template with sample content into a PDF', async () => {
    const draft = await as(alice).preview({ template: definition('预览'), locale: 'zh' });
    expect(draft.status).toBe(200);
    expect(draft.headers.get('content-type')).toBe('application/pdf');
    expect(
      Buffer.from(await draft.arrayBuffer())
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-');

    const template = await created(await as(alice).create(definition(unique('Deck'))));
    const saved = await as(bob).preview({ template_id: template.id, locale: 'en' });
    expect(saved.status).toBe(200);
  });

  it("refuses a malformed definition and someone else's draft", async () => {
    expect((await as(alice).preview({ template: { name: 'x' } })).status).toBe(400);
    const draft = await created(await as(alice).create(definition(unique('Mine'), 'personal')));
    expect((await as(bob).preview({ template_id: draft.id })).status).toBe(404);
  });
});

describe('report templates: activity log', () => {
  // `to` a minute ahead: a change in the same millisecond as "now" would fall outside the window.
  const window = () => ({ to: new Date(Date.now() + 60_000).toISOString() });
  /** Items of one source, sorted by action so same-millisecond changes compare stably. */
  const activity = async (viewer: UserRow, source: 'person' | 'admin', userId?: string) =>
    (await listActivity(db, viewer, { source, module: 'skills', userId, ...window() }, { manifests: [] })).items.sort(
      (a, b) => a.action.localeCompare(b.action),
    );

  it("records a member's own changes as their changes, under SkillHub", async () => {
    const name = unique('Weekly');
    const template = await created(await as(alice).create(definition(name)));
    expect((await as(alice).update(template.id, definition(`${name} v2`))).status).toBe(200);

    const mine = await activity(alice, 'person');
    expect(mine.map((item) => [item.action, item.verb, item.entity])).toEqual([
      ['createReportTemplate', 'create', 'reportTemplate'],
      ['updateReportTemplate', 'update', 'reportTemplate'],
    ]);
    expect(mine[1]).toMatchObject({
      source: 'person',
      module: 'skills',
      actor: { id: alice.id },
      target: { id: template.id, label: `${name} v2`, url: '#/skillhub?tab=reports' },
    });
    // A member sees only their own changes.
    expect(await activity(bob, 'person')).toEqual([]);
  });

  it("records a super changing someone else's or a shipped template as an admin change", async () => {
    const name = unique('Team');
    const template = await created(await as(alice).create(definition(name)));
    expect((await as(admin).update(template.id, definition(`${name} fixed`))).status).toBe(200);
    expect((await as(admin).remove(template.id)).status).toBe(200);

    const adminRows = await activity(admin, 'admin');
    expect(adminRows.map((item) => [item.action, item.verb])).toEqual([
      ['deleteMemberReportTemplate', 'delete'],
      ['updateMemberReportTemplate', 'update'],
    ]);
    expect(adminRows.find((item) => item.action === 'updateMemberReportTemplate')).toMatchObject({
      source: 'admin',
      module: 'skills',
      actor: { id: admin.id },
      detail: `owned by ${alice.nickname}`,
      // Deleted since, so named from what the audit kept — it was a team template.
      target: { id: template.id, label: `${name} fixed` },
    });
    // Not a person change of the super's, and never shown to the member as an admin change.
    // A super sees everyone's person rows: only Alice's create, none of the super's own.
    const personRows = (await activity(admin, 'person')).filter((item) => item.target?.id === template.id);
    expect(personRows.map((item) => [item.actor.id, item.action])).toEqual([[alice.id, 'createReportTemplate']]);
    expect(await activity(alice, 'admin')).toEqual([]);

    const shipped = await db.reportTemplates.create({
      ...DEFAULT_REPORT_TEMPLATES[0]!,
      visibility: 'team',
      owner_user_id: null,
      is_default: true,
      created_by: null,
    });
    expect((await as(admin).remove(shipped.id)).status).toBe(200);
    expect((await activity(admin, 'admin')).find((item) => item.target?.id === shipped.id)).toMatchObject({
      action: 'deleteMemberReportTemplate',
      detail: 'built-in',
    });
  });

  it("records a super's own template as a person change", async () => {
    const template = await created(await as(admin).create(definition(unique('Mine'))));
    expect((await as(admin).update(template.id, definition('Renamed'))).status).toBe(200);
    expect(
      (await activity(admin, 'person')).filter((item) => item.target?.id === template.id).map((item) => item.action),
    ).toEqual(['createReportTemplate', 'updateReportTemplate']);
    expect((await activity(admin, 'admin')).some((item) => item.target?.id === template.id)).toBe(false);
  });

  it("never names a member's draft to anyone else, a super included", async () => {
    const draft = await created(await as(alice).create(definition(unique('Secret'), 'personal')));
    expect((await as(alice).remove(draft.id)).status).toBe(200);
    const own = (await activity(alice, 'person')).find((item) => item.action === 'deleteReportTemplate')!;
    expect(own.target).toMatchObject({ id: draft.id, label: draft.name });
    const seenBySuper = await activity(admin, 'person', alice.id);
    expect(seenBySuper.length).toBe(2);
    for (const item of seenBySuper) expect(item.target).toEqual({ id: draft.id, label: null, url: null });
  });
});
