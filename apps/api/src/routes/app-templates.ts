/**
 * 内置应用模板 — /api/apps/templates（spec 20261011-tables-apps §7，验收 6）
 *
 * 挂在 /api/apps 的链上（requireInternal + requireFeature('apps')），位于 `/:appId` 之前。
 * 模板是 `platform/tables/app-templates/*.json` 里的固定计划；安装走与确认后的计划**同一条**
 * 路径（applySchemaPlan，每一步都是以安装人身份 runtime.dispatch 的 Tables 动作），所以模板
 * 做不到安装人手动做不到的事。安装建一个安装人拥有的新 Base、表与字段、停用状态的自动化和一个
 * **草稿**应用；不授权、不分发、不发布、无 webhook。还要求 `tables` 开关（建的是 Tables Base）。
 *
 * GET  /api/apps/templates               — 模板目录 {templates: AppTemplateSummary[]}（按账号语言）
 * POST /api/apps/templates/:key/install  — 安装 → 201 AppTemplateInstallResult {app, baseId}；
 *                                          未知模板 404；Tables 关闭 403；任一步失败 500 并带逐项结果
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { AppDraftView, AppTemplateInstallResult, AppTemplateSummary } from '@greenhouse/types/apps';
import { logger } from '@greenhouse/utils/logger';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { userHasFeature } from '../auth/features.js';
import { appTemplateSummaries, findAppTemplate } from '../platform/tables/app-templates/index.js';
import { applySchemaPlan } from '../platform/tables/schema-plan.js';
import { actionError, dispatch } from './tables/shared.js';

export const appTemplateRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = await getDb().users.getById(getAuthUser(c).id);
    return c.json({ templates: appTemplateSummaries(user?.locale === 'zh' ? 'zh' : 'en') } satisfies {
      templates: AppTemplateSummary[];
    });
  })
  .post('/:key/install', async (c) => {
    const template = findAppTemplate(c.req.param('key'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    const user = getAuthUser(c);
    if (!(await userHasFeature(user.id, user.role, 'tables'))) {
      return c.json({ error: 'Installing a template creates a Tables Base, and Tables is turned off for you' }, 403);
    }
    const applied = await applySchemaPlan(template.operations, (actionId, payload, ids) =>
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
