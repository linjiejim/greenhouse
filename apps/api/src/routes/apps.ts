/**
 * 应用路由 — /api/apps（Tables → Apps 阶段 1，spec 20261011-tables-apps §4；阶段 2 见
 * 20261011-tables-apps-advanced）
 *
 * 挂 requireInternal() + requireFeature('apps')，**不受** `tables` 开关限制（D1：被分发者不需要
 * Tables 模块）。每个端点经 runtime.dispatch（Tables 清单 1.5.0 的 apps 模块，能力
 * tables.apps.use / manage / publish / review、tables.apps.templates.*），审计记在应用所在的
 * Base 下（scope）、资源是应用。
 * 管理（Base owner / builder）：草稿、版本、受众只读、转交、归档；发布与改受众只有 Base owner /
 * super（D2，builder → 403）；推荐只有 super。网关端点（cards / records / actions / activity /
 * comments / options / uploads / files / usage）按查看者的应用角色实时求值（D3：本人 > 群组按规格
 * 角色顺序 > 全员；拿不到角色 → 404），处理器在 platform/tables/handlers/app-gateway.ts。网关请求体
 * 可带 `previewRole` / `draft`（仅管理者）。拒绝原因在 `details.reason`（AppActionRefusal）。
 *
 * GET    /api/apps                                  — 我管理的 / 分发给我的 / 推荐（AppListView）
 * POST   /api/apps                                  — 新建应用 {baseId, name, description?, icon?, accent?, spec?}（AppDraftView）
 * GET    /api/apps/pins                             — 我置顶的应用（按顺序，只含仍能打开的）
 * PUT    /api/apps/pins                             — 整体替换置顶 {appIds}
 * GET    /api/apps/templates                        — 内置模板目录 {templates}（./app-templates.ts；阶段 2 模板生命周期的其余端点也在那里）
 * POST   /api/apps/templates/:key/install           — 安装模板：新 Base + 草稿应用（AppTemplateInstallResult）
 * GET    /api/apps/reviews                          — 自定义代码审核队列（super；{items: AppCustomReviewItem[]}；阶段 2 占位，切片 S）
 * GET    /api/apps/:appId                           — 打开应用（管理者：已发布版本或 ?draft=1 的草稿，?previewRole= 以角色预览；
 *                                                     查看者：已发布版本按其角色裁剪，看不到的字段 / 谓词不下发）（AppRuntimeView）
 * PATCH  /api/apps/:appId                           — 改名称 / 描述 / 图标 / 颜色
 * GET    /api/apps/:appId/draft                     — 草稿 + draftRevision + 按当前结构的问题（AppDraftView）
 * PUT    /api/apps/:appId/draft                     — 保存草稿 {spec, draftRevision}（修订过期 409；形状错 400；结构问题随响应返回、照存）
 * POST   /api/apps/:appId/publish                   — 发布 {notes?, draftRevision}（owner / super；草稿已变 409；仍有问题 400 spec_invalid）
 * GET    /api/apps/:appId/versions                  — 版本列表（不含规格）
 * POST   /api/apps/:appId/versions/:version/restore — 把旧版本复制回草稿 {draftRevision}
 * POST   /api/apps/:appId/versions/:version/review  — 审核该版本的自定义代码 AppCustomReviewInput {hash, decision, note?}
 *                                                     （super；hash 须等于版本的 specHash；AppVersionSummary；阶段 2 占位，切片 S）
 * GET    /api/apps/:appId/audiences                 — 受众（AppAudiencesView）
 * PUT    /api/apps/:appId/audiences                 — 整体替换受众 {entries, audiencesRevision}（owner / super；群组须授权人可见）
 * POST   /api/apps/:appId/transfer                  — 转交负责人 {userId}（新负责人须是 Base owner / builder）
 * POST   /api/apps/:appId/archive                   — 归档
 * POST   /api/apps/:appId/feature                   — 推荐 / 取消 {featured}（super）
 * POST   /api/apps/:appId/cards/query               — 卡片查询（AppCardQueryInput → AppCardQueryResult：records 卡分页 + refs，
 *                                                     kpi / chart / pivot 卡的聚合，no_access / unavailable；阶段 2：custom 卡带
 *                                                     `bindingId` 求值一个绑定（切片 S）、external 卡求值工具 / 连接器数据源
 *                                                     （切片 SRC），落地前回 400 not_implemented）
 * POST   /api/apps/:appId/records/get               — 记录详情 {pageId, cardId, recordId}（AppRecordView）
 * POST   /api/apps/:appId/actions                   — 执行动作（AppActionInput → AppActionResult；同一 requestId 重放首个结果）
 * POST   /api/apps/:appId/activity                  — 记录动态 {pageId, cardId, recordId, cursor?}（TableRecordActivityPage）
 * POST   /api/apps/:appId/comments                  — 发评论 {pageId, cardId, recordId, body}（{comment}）
 * PATCH  /api/apps/:appId/comments/:commentId       — 改评论 {pageId, cardId, body}（作者）
 * DELETE /api/apps/:appId/comments/:commentId       — 删评论 {pageId, cardId}（作者；管理者可删任何人的）
 * POST   /api/apps/:appId/options                   — 字段选项 {pageId, cardId, fieldId, search?, buttonId?}（AppFieldOptionsView）
 * POST   /api/apps/:appId/uploads                   — multipart `file` + pageId / cardId / fieldId：暂存附件（{file}，下一次写入时挂载）
 * GET    /api/apps/:appId/files/:fileId             — 下载附件（?pageId&cardId&recordId&fieldId；处理器回 {fileId} 后由这里送字节）
 * GET    /api/apps/:appId/usage                     — 用量摘要（管理者，AppUsageView）
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getDb } from '@greenhouse/db';
import type {
  AppActionResult,
  AppAudiencesView,
  AppCardQueryResult,
  AppCustomReviewItem,
  AppDraftView,
  AppFieldOptionsView,
  AppListView,
  AppRecordView,
  AppRuntimeView,
  AppSummary,
  AppUploadView,
  AppUsageView,
  AppVersionSummary,
} from '@greenhouse/types/apps';
import type { TableRecordActivityPage, TableRecordCommentView } from '@greenhouse/types/tables';
import type { AppEnv } from '../app-env.js';
import { MAX_DRIVE_FILE_SIZE } from '../drive/upload-policy.js';
import { serveDriveFileContent } from '../drive/serve-file.js';
import { appTemplateRoutes } from './app-templates.js';
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
  // Before `/:appId` too: built-in templates (./app-templates.ts).
  .route('/templates', appTemplateRoutes)
  // Before `/:appId` too: the custom-code review queue (super; slice S).
  .get('/reviews', async (c) => {
    const result = await dispatch(c, 'listAppCustomReviews', {});
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { items: AppCustomReviewItem[] });
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
    return c.json(result.data as { app: AppSummary; version: AppVersionSummary; pendingReview?: boolean });
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
  .post('/:appId/versions/:version/review', async (c) => {
    const appId = appIdOf(c);
    const version = numberParam(c, 'version');
    const result = await dispatch(c, 'reviewAppCustomCode', { ...(await jsonBody(c)), appId, version }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppVersionSummary);
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
    return c.json(result.data as AppCardQueryResult);
  })
  .post('/:appId/records/get', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'getAppRecord', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppRecordView);
  })
  .post('/:appId/actions', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'runAppAction', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppActionResult);
  })
  .post('/:appId/activity', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'listAppActivity', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableRecordActivityPage);
  })
  .post('/:appId/comments', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'createAppComment', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { comment: TableRecordCommentView }, 201);
  })
  .patch('/:appId/comments/:commentId', async (c) => {
    const appId = appIdOf(c);
    const commentId = numberParam(c, 'commentId');
    const result = await dispatch(c, 'updateAppComment', { ...(await jsonBody(c)), appId, commentId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { comment: TableRecordCommentView });
  })
  .delete('/:appId/comments/:commentId', async (c) => {
    const appId = appIdOf(c);
    const commentId = numberParam(c, 'commentId');
    const result = await dispatch(c, 'deleteAppComment', { ...(await jsonBody(c)), appId, commentId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { deleted: true; commentId: number });
  })
  .post('/:appId/options', async (c) => {
    const appId = appIdOf(c);
    const result = await dispatch(c, 'listAppFieldOptions', { ...(await jsonBody(c)), appId }, { appId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as AppFieldOptionsView);
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
        // Managers only (the session ignores them for anyone else): a draft preview uploads to its own cards.
        previewRole: field('previewRole'),
        draft: field('draft') === '1' || field('draft') === 'true',
      };
      const result = await dispatch(c, 'uploadAppFile', payload, { appId });
      if (!result.ok) return actionError(c, result);
      return c.json(result.data as { file: AppUploadView }, 201);
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
      previewRole: c.req.query('previewRole') || undefined,
      draft: c.req.query('draft') === '1' || c.req.query('draft') === 'true',
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
    return c.json(result.data as AppUsageView);
  });

export default appRoutes;
