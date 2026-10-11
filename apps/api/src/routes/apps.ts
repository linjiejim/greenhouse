/**
 * 应用路由 — /api/apps（Tables → Apps 阶段 1，spec 20261011-tables-apps §4）
 *
 * 挂 requireInternal() + requireFeature('apps')，**不受** `tables` 开关限制（D1：被分发者不需要
 * Tables 模块）。每个端点经 runtime.dispatch（Tables 清单 1.4.0 的 apps 模块，能力
 * tables.apps.use / manage / publish），审计记在应用所在的 Base 下（scope）、资源是应用。
 * 管理（Base owner / builder）：草稿、版本、受众只读、转交、归档；发布与改受众只有 Base owner /
 * super（D2，builder → 403）；推荐只有 super。网关端点（cards / records / actions / activity /
 * comments / options / uploads / files / usage）由切片 G 实现，在此之前回 400 `not_implemented`。
 *
 * GET    /api/apps                                  — 我管理的 / 分发给我的 / 推荐（AppListView）
 * POST   /api/apps                                  — 新建应用 {baseId, name, description?, icon?, accent?, spec?}（AppDraftView）
 * GET    /api/apps/pins                             — 我置顶的应用（按顺序，只含仍能打开的）
 * PUT    /api/apps/pins                             — 整体替换置顶 {appIds}
 * GET    /api/apps/:appId                           — 打开应用（管理者：已发布版本或 ?draft=1 的草稿，?previewRole= 以角色预览；
 *                                                     查看者的按角色视图属于切片 G）（AppRuntimeView）
 * PATCH  /api/apps/:appId                           — 改名称 / 描述 / 图标 / 颜色
 * GET    /api/apps/:appId/draft                     — 草稿 + draftRevision + 按当前结构的问题（AppDraftView）
 * PUT    /api/apps/:appId/draft                     — 保存草稿 {spec, draftRevision}（修订过期 409；形状错 400；结构问题随响应返回、照存）
 * POST   /api/apps/:appId/publish                   — 发布 {notes?, draftRevision}（owner / super；草稿已变 409；仍有问题 400 spec_invalid）
 * GET    /api/apps/:appId/versions                  — 版本列表（不含规格）
 * POST   /api/apps/:appId/versions/:version/restore — 把旧版本复制回草稿 {draftRevision}
 * GET    /api/apps/:appId/audiences                 — 受众（AppAudiencesView）
 * PUT    /api/apps/:appId/audiences                 — 整体替换受众 {entries, audiencesRevision}（owner / super；群组须授权人可见）
 * POST   /api/apps/:appId/transfer                  — 转交负责人 {userId}（新负责人须是 Base owner / builder）
 * POST   /api/apps/:appId/archive                   — 归档
 * POST   /api/apps/:appId/feature                   — 推荐 / 取消 {featured}（super）
 * POST   /api/apps/:appId/cards/query               — 卡片查询（AppCardQueryInput）
 * POST   /api/apps/:appId/records/get               — 记录详情 {pageId, cardId, recordId}
 * POST   /api/apps/:appId/actions                   — 执行动作（AppActionInput）
 * POST   /api/apps/:appId/activity                  — 记录动态 {pageId, cardId, recordId, cursor?}
 * POST   /api/apps/:appId/comments                  — 发评论 {pageId, cardId, recordId, body}
 * PATCH  /api/apps/:appId/comments/:commentId       — 改评论
 * DELETE /api/apps/:appId/comments/:commentId       — 删评论
 * POST   /api/apps/:appId/options                   — 字段选项 {pageId, cardId, fieldId, search?}
 * POST   /api/apps/:appId/uploads                   — multipart `file` + pageId / cardId / fieldId：上传附件（待挂载）
 * GET    /api/apps/:appId/files/:fileId             — 下载附件（?pageId&cardId&recordId&fieldId；处理器回 {fileId} 后由这里送字节）
 * GET    /api/apps/:appId/usage                     — 用量摘要（管理者）
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getDb } from '@greenhouse/db';
import type {
  AppAudiencesView,
  AppDraftView,
  AppListView,
  AppRuntimeView,
  AppSummary,
  AppVersionSummary,
} from '@greenhouse/types/apps';
import type { AppEnv } from '../app-env.js';
import { MAX_DRIVE_FILE_SIZE } from '../drive/upload-policy.js';
import { serveDriveFileContent } from '../drive/serve-file.js';
import { actionError, dispatch, jsonBody, numberParam } from './tables/shared.js';

/** Multipart framing (boundary + part headers) on top of the Drive file cap. */
const MAX_UPLOAD_BODY_BYTES = MAX_DRIVE_FILE_SIZE + 1024 * 1024;

function appIdOf(c: Context<AppEnv>): number {
  return numberParam(c, 'appId');
}

/** Query-string ids (the file download is a GET). */
function queryInt(c: Context<AppEnv>, key: string): number | undefined {
  const value = Number(c.req.query(key));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const appRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const result = await dispatch(c, 'listApps', {});
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppListView);
  })
  .post('/', async (c) => {
    const body = await jsonBody(c);
    const baseId = Number(body.baseId);
    const result = await dispatch(c, 'createApp', body, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppDraftView, 201);
  })
  // Before `/:appId`: `pins` is not an app id.
  .get('/pins', async (c) => {
    const result = await dispatch(c, 'listAppPins', {});
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { apps: AppSummary[] });
  })
  .put('/pins', async (c) => {
    const result = await dispatch(c, 'setAppPins', await jsonBody(c));
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { apps: AppSummary[] });
  })
  .get('/:appId', async (c) => {
    const appId = appIdOf(c);
    const payload = {
      appId,
      draft: c.req.query('draft') === '1' || c.req.query('draft') === 'true',
      previewRole: c.req.query('previewRole') || undefined,
    };
    const result = await dispatch(c, 'getApp', payload, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppRuntimeView);
  })
  .patch('/:appId', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'updateApp', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { app: AppSummary });
  })
  .get('/:appId/draft', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'getAppDraft', { appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppDraftView);
  })
  .put('/:appId/draft', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'saveAppDraft', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppDraftView);
  })
  .post('/:appId/publish', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'publishApp', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { app: AppSummary; version: AppVersionSummary });
  })
  .get('/:appId/versions', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'listAppVersions', { appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { versions: AppVersionSummary[] });
  })
  .post('/:appId/versions/:version/restore', async (c) => {
    const appId = appIdOf(c);
    const version = numberParam(c, 'version');
    const result = await dispatch(c, 'restoreAppVersion', { ...(await jsonBody(c)), appId, version }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppDraftView);
  })
  .get('/:appId/audiences', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'listAppAudiences', { appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppAudiencesView);
  })
  .put('/:appId/audiences', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'setAppAudiences', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppAudiencesView);
  })
  .post('/:appId/transfer', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'transferApp', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { app: AppSummary });
  })
  .post('/:appId/archive', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'archiveApp', { appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { app: AppSummary });
  })
  .post('/:appId/feature', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'featureApp', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { app: AppSummary });
  })
  // ─── Gateway (slice G) ───
  .post('/:appId/cards/query', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'queryAppCard', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  })
  .post('/:appId/records/get', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'getAppRecord', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  })
  .post('/:appId/actions', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'runAppAction', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  })
  .post('/:appId/activity', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'listAppActivity', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  })
  .post('/:appId/comments', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'createAppComment', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>, 201);
  })
  .patch('/:appId/comments/:commentId', async (c) => {
    const appId = appIdOf(c);
    const commentId = numberParam(c, 'commentId');
    const result = await dispatch(c, 'updateAppComment', { ...(await jsonBody(c)), appId, commentId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  })
  .delete('/:appId/comments/:commentId', async (c) => {
    const appId = appIdOf(c);
    const commentId = numberParam(c, 'commentId');
    const result = await dispatch(c, 'deleteAppComment', { ...(await jsonBody(c)), appId, commentId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  })
  .post('/:appId/options', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'listAppFieldOptions', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  })
  .post(
    '/:appId/uploads',
    bodyLimit({
      maxSize: MAX_UPLOAD_BODY_BYTES,
      onError: (c) => c.json({ error: 'file too large' }, 413),
    }),
    async (c) => {
      const appId = appIdOf(c);
      const body = await c.req.parseBody().catch(() => null);
      const file = body?.['file'];
      if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
      const field = (key: string) => (typeof body?.[key] === 'string' ? (body[key] as string) : undefined);
      const payload = {
        appId,
        pageId: field('pageId'),
        cardId: field('cardId'),
        fieldId: Number(field('fieldId')) || undefined,
        file,
      };
      const result = await dispatch(c, 'uploadAppFile', payload, { appId });
      if (!result.ok) return actionError(c, result);
      return c.json(result.data as Record<string, unknown>, 201);
    },
  )
  .get('/:appId/files/:fileId', async (c) => {
    const appId = appIdOf(c);
    const payload = {
      appId,
      fileId: numberParam(c, 'fileId'),
      pageId: c.req.query('pageId') || undefined,
      cardId: c.req.query('cardId') || undefined,
      recordId: queryInt(c, 'recordId'),
      fieldId: queryInt(c, 'fieldId'),
    };
    const result = await dispatch(c, 'getAppFile', payload, { appId });
    if (!result.ok) return actionError(c, result);
    // The handler authorized this file for the viewer's role; the bytes go out like Drive's.
    const { fileId } = result.data as { fileId: number };
    const file = await getDb().drive.getFile(fileId);
    if (!file || file.status !== 'active') return c.json({ error: 'not found' }, 404);
    return serveDriveFileContent(c, file);
  })
  .get('/:appId/usage', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'getAppUsage', { appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as Record<string, unknown>);
  });

export default appRoutes;
