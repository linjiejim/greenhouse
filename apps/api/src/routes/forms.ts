/**
 * 表单路由 — /api/forms（只提交的表单入口，spec 20261011-tables-foundation §3 / D5）
 *
 * 只挂 requireInternal()，**不受** `tables` 功能开关限制：开关的含义是「能使用 Tables
 * 模块」，被分发表单的人不需要它。权限仍全部经 runtime.dispatch（能力
 * `tables.data.submitForm`），受众判定在 openForm / submitForm 的处理器里（切片 Fm）。
 *
 * GET  /api/forms/:formId          — 打开表单（提交视图：字段、选项，不含 Base 数据）
 * POST /api/forms/:formId/uploads  — 以提交人身份上传附件（切片 Fm，未实现前返回 501）
 * POST /api/forms/:formId/submit   — 提交（只回成功文案，不回记录）
 */

import { Hono } from 'hono';
import type { TableFormSubmitView } from '@greenhouse/types/tables';
import type { AppEnv } from '../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './tables/shared.js';

const formRoutes = new Hono<AppEnv>()
  .get('/:formId', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'openForm', { formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormSubmitView });
  })
  .post('/:formId/uploads', async (c) =>
    c.json({ error: 'not_implemented', details: { notImplemented: true as const } }, 501),
  )
  .post('/:formId/submit', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'submitForm', { ...(await jsonBody(c)), formId }, { formId });
    if (!result.ok) return actionError(c, result);
    const { successMessage } = result.data as { successMessage?: string | null };
    return c.json({ submitted: true as const, successMessage: successMessage ?? null }, 201);
  });

export default formRoutes;
