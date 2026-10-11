/**
 * Tables 路由 — /api/tables（Platform Kernel 适配层，每个端点都经 runtime.dispatch）
 *
 * 按领域拆成子路由（./bases ./schema ./views ./forms ./records ./imports
 * ./automations ./dashboards），在这里用 `.route('/', …)` 组合成一条链，AppType 因此仍带全部端点。
 * 新端点加进所属领域的子路由；新领域在这里追加一个 `.route()`。
 *
 * Base 与成员（./bases.ts）
 * GET    /meta/users                                 — 可选内部成员
 * GET    /bases                                      — 可见 Base
 * POST   /bases                                      — 创建 Base + 默认 Table
 * GET    /bases/:baseId                              — Base 工作区（含生效访问级别 access）
 * PATCH  /bases/:baseId                              — 更新 Base
 * POST   /bases/:baseId/archive                      — 归档 Base
 * GET    /bases/:baseId/members                      — 成员列表
 * GET    /bases/:baseId/audit                        — Base 操作审计（仅 owner）
 * PUT    /bases/:baseId/members/:userId              — 添加/更新成员
 * DELETE /bases/:baseId/members/:userId              — 移除成员
 *
 * 表、字段与结构（./schema.ts）
 * GET    /bases/:baseId/tables                       — Table 列表
 * POST   /bases/:baseId/tables                       — 创建 Table
 * PATCH  /tables/:tableId                            — 更新 Table
 * POST   /tables/:tableId/archive                    — 归档 Table（仅 owner，可由 CLI 恢复）
 * GET    /tables/:tableId/schema                     — 字段与视图 schema
 * GET    /tables/:tableId/schema/versions            — Schema 版本列表
 * GET    /tables/:tableId/schema/versions/:version   — Schema 快照
 * POST   /tables/:tableId/fields                     — 创建字段
 * PATCH  /fields/:fieldId                            — 更新字段
 * POST   /fields/:fieldId/archive                    — 归档字段
 * POST   /schema-plan/apply                          — 应用一份已确认的结构变更计划
 *
 * 视图（./views.ts）
 * GET    /tables/:tableId/views                      — 视图列表
 * POST   /tables/:tableId/views                      — 创建视图
 * PATCH  /views/:viewId                              — 更新视图
 *
 * 表单（./forms.ts；面向受众的只提交入口是 /api/forms，见 routes/forms.ts）
 * GET    /tables/:tableId/forms                      — 表单列表（builder）
 * POST   /tables/:tableId/forms                      — 创建表单
 * GET    /forms/:formId                              — 读取表单 + 字段
 * PATCH  /forms/:formId                              — revision 更新表单
 * POST   /forms/:formId/submit                       — 提交表单（Base 成员，返回记录）
 *
 * 记录（./records.ts；/records/deleted 必须注册在 /records/:recordId 之前）
 * POST   /tables/:tableId/records/query              — 查询记录
 * POST   /tables/:tableId/records                    — 创建记录
 * GET    /tables/:tableId/records/deleted            — 回收站（已软删记录）
 * POST   /tables/:tableId/records/:recordId/restore  — 从回收站恢复记录
 * GET    /tables/:tableId/records/:recordId          — 读取记录
 * PATCH  /tables/:tableId/records/:recordId          — revision 更新记录
 * POST   /tables/:tableId/records/batch-upsert       — 批量 upsert
 * POST   /tables/:tableId/records/batch-validate     — 批量预校验
 * DELETE /tables/:tableId/records/:recordId          — revision 软删除
 *
 * 导入（./imports.ts；CSV / Excel，归上传者与这张表）
 * POST   /tables/:tableId/imports                    — 上传（multipart file ≤10 MB）→ 列、样例、类型推断、建议映射
 * POST   /tables/:tableId/imports/:importId/validate — 按映射预检全部行（不写入）
 * POST   /tables/:tableId/imports/:importId/commit   — 提交（每次写几秒；committing 时再调一次续写）
 *
 * 自动化（./automations.ts）
 * GET    /bases/:baseId/automations                  — 自动化规则列表（builder）
 * POST   /bases/:baseId/automations                  — 创建规则
 * PATCH  /automations/:automationId                  — revision 更新规则
 * GET    /automations/:automationId/runs             — 运行记录
 *
 * 仪表盘（./dashboards.ts）
 * GET    /bases/:baseId/dashboards                   — Dashboard 列表
 * POST   /bases/:baseId/dashboards                   — 创建 Dashboard
 * GET    /dashboards/:dashboardId                    — Dashboard + widgets
 * PATCH  /dashboards/:dashboardId                    — 更新 Dashboard
 * DELETE /dashboards/:dashboardId                    — 删除 Dashboard（仅 owner，硬删不可恢复）
 * POST   /dashboards/:dashboardId/widgets            — 创建 widget
 * PATCH  /dashboard-widgets/:widgetId                — 更新 widget
 * DELETE /dashboard-widgets/:widgetId                — 删除 widget
 * POST   /dashboard-widgets/:widgetId/query          — 服务端 widget 查询
 *
 * 旧的 `/notifications` 两个端点已随 Tables 1.3.0 移除：自动化通知改走平台通知中心
 * （/api/notifications，kind `tables_automation`）。
 */

import { Hono } from 'hono';
import type { AppEnv } from '../../app-env.js';
import { automationRoutes } from './automations.js';
import { baseRoutes } from './bases.js';
import { dashboardRoutes } from './dashboards.js';
import { formRoutes } from './forms.js';
import { importRoutes } from './imports.js';
import { recordRoutes } from './records.js';
import { schemaRoutes } from './schema.js';
import { viewRoutes } from './views.js';

const tablesRoutes = new Hono<AppEnv>()
  .route('/', baseRoutes)
  .route('/', schemaRoutes)
  .route('/', viewRoutes)
  .route('/', formRoutes)
  .route('/', recordRoutes)
  .route('/', importRoutes)
  .route('/', automationRoutes)
  .route('/', dashboardRoutes);

export default tablesRoutes;
