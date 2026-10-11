/**
 * 内置应用模板 — /api/apps/templates（spec 20261011-tables-apps §7，验收 6）
 *
 * 挂在 /api/apps 的链上（requireInternal + requireFeature('apps')），位于 `/:appId` 之前。
 * 模板是 `platform/tables/app-templates/*.json` 里的固定计划；安装走与确认后的计划**同一条**
 * 路径（applySchemaPlan，每一步都是以安装人身份 runtime.dispatch 的 Tables 动作），所以模板
 * 做不到安装人手动做不到的事。安装建一个安装人拥有的新 Base、表与字段、停用状态的自动化和一个
 * **草稿**应用；不授权、不分发、不发布、无 webhook。还要求 `tables` 开关（建的是 Tables Base）。
 * 列表与安装用同一种语言（账号语言，`templateLocale`）：英文账号看到英文模板，装出来的 Base、
 * 字段、选项、页面、角色、按钮与自动化也都是英文。
 *
 * GET  /api/apps/templates               — 模板目录 {templates: AppTemplateSummary[]}（按账号语言）
 * POST /api/apps/templates/:key/install  — 按账号语言安装 → 201 AppTemplateInstallResult {app, baseId}；
 *                                          未知模板 404；Tables 关闭 403；任一步失败 500 并带逐项结果
 *
 * 阶段 2 模板生命周期（spec 20261011-tables-apps-advanced §6，清单 1.5.0；处理器是
 * platform/tables/handlers/app-templates.ts 的占位，切片 T 实现，届时上面两条也改走生命周期动作
 * listAppTemplates / installAppTemplate，响应形状不变、只追加 source / version / reviewStatus）：
 * POST /api/apps/templates                                — 另存为模板（新模板）AppTemplatePublishInput → 201 AppTemplateDetailView
 * GET  /api/apps/templates/:key                           — 模板详情 AppTemplateDetailView（版本、审核状态、会建出什么）
 * POST /api/apps/templates/:key/versions                  — 发布新版本 AppTemplatePublishInput（semver 递增 + changelog）→ 201 AppTemplateDetailView
 * POST /api/apps/templates/:key/versions/:version/review  — 审核 AppTemplateReviewInput {decision, note?}（super）→ AppTemplateVersionView
 * POST /api/apps/templates/:key/archive                   — 归档（发布人 / super）→ AppTemplateDetailView
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type {
  AppDraftView,
  AppTemplateDetailView,
  AppTemplateInstallResult,
  AppTemplateSummary,
  AppTemplateVersionView,
} from '@greenhouse/types/apps';
import { logger } from '@greenhouse/utils/logger';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { userHasFeature } from '../auth/features.js';
import { appTemplateSummaries, findAppTemplate, templateLocale } from '../platform/tables/app-templates/index.js';
import { applySchemaPlan } from '../platform/tables/schema-plan.js';
import { actionError, dispatch, jsonBody } from './tables/shared.js';

export const appTemplateRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = await getDb().users.getById(getAuthUser(c).id);
    return c.json({ templates: appTemplateSummaries(templateLocale(user?.locale)) } satisfies {
      templates: AppTemplateSummary[];
    });
  })
  // ─── Phase 2 lifecycle (slice T; placeholders answer 400 not_implemented) ───
  .post('/', async (c) => {
    const result = await dispatch(c, 'publishAppTemplate', await jsonBody(c));
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateDetailView, 201);
  })
  .get('/:key', async (c) => {
    const result = await dispatch(c, 'getAppTemplate', { key: c.req.param('key') });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateDetailView);
  })
  .post('/:key/versions', async (c) => {
    const result = await dispatch(c, 'publishAppTemplate', { ...(await jsonBody(c)), key: c.req.param('key') });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateDetailView, 201);
  })
  .post('/:key/versions/:version/review', async (c) => {
    const payload = { ...(await jsonBody(c)), key: c.req.param('key'), version: c.req.param('version') };
    const result = await dispatch(c, 'reviewAppTemplate', payload);
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateVersionView);
  })
  .post('/:key/archive', async (c) => {
    const result = await dispatch(c, 'archiveAppTemplate', { key: c.req.param('key') });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateDetailView);
  })
  .post('/:key/install', async (c) => {
    const template = findAppTemplate(c.req.param('key'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    const user = getAuthUser(c);
    if (!(await userHasFeature(user.id, user.role, 'tables'))) {
      return c.json({ error: 'Installing a template creates a Tables Base, and Tables is turned off for you' }, 403);
    }
    // Installed in the language the center listed it in.
    const plan = template.plans[templateLocale((await getDb().users.getById(user.id))?.locale)];
    const applied = await applySchemaPlan(plan.operations, (actionId, payload, ids) =>
      dispatch(c, actionId, payload, ids),
    );
    const unfinished = applied.results.filter((result) => result.status !== 'applied');
    const appId = applied.refs?.[template.appRef]?.id;
    if (unfinished.length > 0 || appId === undefined || applied.baseId === undefined) {
      logger.warn('[apps] template install did not finish', {
        template: template.key,
        userId: user.id,
        unfinished: unfinished.map((result) => ({ index: result.index, op: result.op, message: result.message })),
      });
      return c.json(
        { error: 'The template could not be installed completely', details: { results: applied.results } },
        500,
      );
    }
    const draft = await dispatch(c, 'getAppDraft', { appId }, { appId });
    if (!draft.ok) return actionError(c, draft);
    return c.json(
      { app: (draft.data as AppDraftView).app, baseId: applied.baseId } satisfies AppTemplateInstallResult,
      201,
    );
  });
