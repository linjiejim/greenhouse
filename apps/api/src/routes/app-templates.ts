/**
 * 应用模板目录与版本生命周期 — /api/apps/templates。
 *
 * 挂在 /api/apps 的链上（requireInternal + requireFeature('apps')），位于 `/:appId` 之前。
 * 内置模板从 repo 同步入库；用户模板从已保存草稿与结构生成不可变计划。安装走与确认后的计划**同一条**
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
 * 所有路由统一走 Tables guarded dispatch。含自动化/自定义代码或扫描异常的版本须经 super 审核，
 * 审核只批准模板安装，不开启自定义 HTML 执行。安装接受可选 {name}，给新 Base 与应用命名。
 * POST /api/apps/templates                                — 另存为模板（新模板）AppTemplatePublishInput → 201 AppTemplateDetailView
 * GET  /api/apps/templates/:key                           — 模板详情 AppTemplateDetailView（版本、审核状态、会建出什么）
 * POST /api/apps/templates/:key/versions                  — 发布新版本 AppTemplatePublishInput（semver 递增 + changelog）→ 201 AppTemplateDetailView
 * POST /api/apps/templates/:key/versions/:version/review  — 审核 AppTemplateReviewInput {decision, note?}（super）→ AppTemplateVersionView
 * POST /api/apps/templates/:key/archive                   — 归档（发布人 / super）→ AppTemplateDetailView
 */

import { Hono } from 'hono';
import type {
  AppTemplateDetailView,
  AppTemplateInstallResult,
  AppTemplateSummary,
  AppTemplateVersionView,
} from '@greenhouse/types/apps';
import type { AppEnv } from '../app-env.js';
import { actionError, dispatch, jsonBody } from './tables/shared.js';

export const appTemplateRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const result = await dispatch(c, 'listAppTemplates', {});
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { templates: AppTemplateSummary[] });
  })
  .post('/', async (c) => {
    const result = await dispatch(c, 'publishAppTemplate', await jsonBody(c));
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateDetailView, 201);
  })
  .get('/:key', async (c) => {
    const result = await dispatch(c, 'getAppTemplate', { key: c.req.param('key'), version: c.req.query('version') });
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
    const result = await dispatch(c, 'archiveAppTemplate', {
      key: c.req.param('key'),
      version: c.req.query('version'),
    });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateDetailView);
  })
  .post('/:key/install', async (c) => {
    const result = await dispatch(c, 'installAppTemplate', { ...(await jsonBody(c)), key: c.req.param('key') });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppTemplateInstallResult, 201);
  });
