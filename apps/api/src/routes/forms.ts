/**
 * 表单路由 — /api/forms（只提交的表单入口，spec 20261011-tables-foundation §3 / D5）
 *
 * 只挂 requireInternal()，**不受** `tables` 功能开关限制：开关的含义是「能使用 Tables
 * 模块」，被分发表单的人不需要它。打开 / 提交经 runtime.dispatch（`openForm` /
 * `submitForm`，能力 `tables.data.submitForm`），受众判定在
 * platform/tables/form-access.ts；上传不是清单动作，先查同一能力再过同一受众门。
 *
 * GET  /api/forms/:formId          — 打开表单（TableFormSubmitView：字段、选项，不含 Base 数据与预填值）
 * POST /api/forms/:formId/uploads  — multipart `file`：以提交人身份暂存附件（待挂载，24h 未提交即回收）
 * POST /api/forms/:formId/submit   — `{values, timeZone?}` 提交（只回成功文案，不回记录；单次表单重复提交 409）
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getDb } from '@greenhouse/db';
import type { TableFormSubmitResult, TableFormSubmitView, TableFormUploadView } from '@greenhouse/types/tables';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { MAX_DRIVE_FILE_SIZE } from '../drive/upload-policy.js';
import { humanActor } from '../platform/actor.js';
import { stageFormUpload } from '../platform/tables/form-uploads.js';
import { actionError, dispatch, jsonBody, numberParam } from './tables/shared.js';

/** Multipart framing (boundary + part headers) on top of the Drive file cap. */
const MAX_UPLOAD_BODY_BYTES = MAX_DRIVE_FILE_SIZE + 1024 * 1024;

const formRoutes = new Hono<AppEnv>()
  .get('/:formId', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'openForm', { formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormSubmitView });
  })
  .post(
    '/:formId/uploads',
    bodyLimit({
      maxSize: MAX_UPLOAD_BODY_BYTES,
      onError: (c) => c.json({ error: 'file too large' }, 413),
    }),
    async (c) => {
      const formId = numberParam(c, 'formId');
      if (!Number.isInteger(formId) || formId <= 0) return c.json({ error: 'Form not found' }, 404);
      const body = await c.req.parseBody().catch(() => null);
      const file = body?.['file'];
      if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
      const result = await stageFormUpload({ db: getDb() }, humanActor(getAuthUser(c), c), formId, file);
      if (!result.ok) {
        return c.json(
          { error: result.error, ...(result.reason ? { details: { reason: result.reason } } : {}) },
          result.status,
        );
      }
      return c.json({ file: result.file satisfies TableFormUploadView }, 201);
    },
  )
  .post('/:formId/submit', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'submitForm', { ...(await jsonBody(c)), formId }, { formId });
    if (!result.ok) return actionError(c, result);
    const { successMessage } = result.data as { successMessage?: string | null };
    return c.json({ submitted: true, successMessage: successMessage ?? null } satisfies TableFormSubmitResult, 201);
  });

export default formRoutes;
