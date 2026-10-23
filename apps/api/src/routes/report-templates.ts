/**
 * 报告模板路由 — /api/report-templates（内部用户；v1.7）
 *
 * GET    /api/report-templates          — 我能看到的模板（团队模板 + 我的草稿）
 * GET    /api/report-templates/:id      — 单个模板
 * POST   /api/report-templates          — 新建（任何成员可发布团队模板，或存为个人草稿）
 * PUT    /api/report-templates/:id      — 修改（团队模板：作者或 super；草稿：作者）
 * DELETE /api/report-templates/:id      — 删除（同上，软删）
 * POST   /api/report-templates/preview  — 用示例内容把模板定义渲染成 PDF（不保存）
 *
 * Visibility and edit rights live in reports/templates.ts — the same
 * implementation the report_templates / report_render agent tools use.
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { checkReportTemplateDefinition } from '@greenhouse/types/reports';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  type TemplateErrorCode,
} from '../reports/templates.js';
import { resolveReportBrand } from '../reports/brand.js';
import { checkReportContent } from '../reports/content.js';
import { renderPdf } from '../reports/render-pdf.js';
import { sampleReportContent } from '../reports/sample.js';

const STATUS: Record<TemplateErrorCode, 400 | 403 | 404> = { invalid: 400, forbidden: 403, not_found: 404 };

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

const reportTemplateRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = getAuthUser(c);
    return c.json({ templates: await listTemplates(getDb(), { userId: user.id, role: user.role }) });
  })
  .post('/preview', async (c) => {
    const user = getAuthUser(c);
    const body = (await readJson(c)) as { template?: unknown; template_id?: unknown; locale?: unknown } | null;
    let definition;
    if (typeof body?.template_id === 'string') {
      const found = await getTemplate(getDb(), { userId: user.id, role: user.role }, body.template_id);
      if (!found.ok) return c.json({ error: found.error }, STATUS[found.code]);
      definition = found.value;
    } else {
      const checked = checkReportTemplateDefinition(body?.template);
      if (!checked.ok) return c.json({ error: checked.errors[0]!, errors: checked.errors }, 400);
      definition = checked.value;
    }
    const locale = body?.locale === 'en' ? 'en' : 'zh';
    const template = { ...definition, id: 'preview', version: 1, formats: ['pdf' as const] };
    const checked = checkReportContent(template, sampleReportContent(definition, locale));
    if (!checked.ok) return c.json({ error: checked.issues[0]!.message }, 400);
    const pdf = await renderPdf(checked.document, await resolveReportBrand());
    return c.body(new Uint8Array(pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="preview.pdf"',
      'Cache-Control': 'no-store',
    });
  })
  .get('/:id', async (c) => {
    const user = getAuthUser(c);
    const result = await getTemplate(getDb(), { userId: user.id, role: user.role }, c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.code]);
    return c.json({ template: result.value });
  })
  .post('/', async (c) => {
    const user = getAuthUser(c);
    const result = await createTemplate(getDb(), { userId: user.id, role: user.role }, await readJson(c));
    if (!result.ok) return c.json({ error: result.error, errors: result.errors ?? [] }, STATUS[result.code]);
    return c.json({ template: result.value }, 201);
  })
  .put('/:id', async (c) => {
    const user = getAuthUser(c);
    const result = await updateTemplate(
      getDb(),
      { userId: user.id, role: user.role },
      c.req.param('id'),
      await readJson(c),
    );
    if (!result.ok) return c.json({ error: result.error, errors: result.errors ?? [] }, STATUS[result.code]);
    return c.json({ template: result.value });
  })
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    const result = await deleteTemplate(getDb(), { userId: user.id, role: user.role }, c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.code]);
    return c.json({ deleted: true, id: result.value.id });
  });

export default reportTemplateRoutes;
