/**
 * Tables 路由 — /api/tables（Platform Kernel 适配层，每个端点都经 runtime.dispatch）
 *
 * 按领域拆成子路由（./bases ./access ./schema ./views ./forms ./records ./imports
 * ./activity ./automations ./dashboards），在这里用 `.route('/', …)` 组合成一条链，AppType 因此仍带全部端点。
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
 * GET    /bases/:baseId/audit                        — Base 写操作审计（仅 owner；按 Base 一次索引读取，读动作不列）
 * PUT    /bases/:baseId/members/:userId              — 添加/更新成员（builder/editor/viewer/custom + customRoleId）
 * DELETE /bases/:baseId/members/:userId              — 移除成员
 *
 * 访问控制（./access.ts，均仅 owner / super）
 * GET    /bases/:baseId/roles                        — 自定义角色 + 引用计数 + 规则编辑器所需的结构事实
 * POST   /bases/:baseId/roles                        — 创建自定义角色
 * PATCH  /roles/:roleId                              — revision 更新角色
 * DELETE /roles/:roleId                              — 删除角色（仍被引用 → 409 role_in_use）
 * PUT    /bases/:baseId/groups/:groupId              — 授予群组 editor/viewer/custom（授权人须看得见该群组）
 * DELETE /bases/:baseId/groups/:groupId              — 移除群组授权
 * POST   /bases/:baseId/transfer                     — 转移所有者 {userId, previousOwnerRole}
 *
 * 表、字段与结构（./schema.ts）
 * GET    /bases/:baseId/tables                       — Table 列表
 * POST   /bases/:baseId/tables                       — 创建 Table
 * PATCH  /tables/:tableId                            — 更新 Table
 * POST   /tables/:tableId/archive                    — 归档 Table（仅 owner，可由 CLI 恢复；被应用引用 → 409 used_by_apps，{confirm:true} 继续）
 * GET    /tables/:tableId/schema                     — 字段与视图 schema
 * GET    /tables/:tableId/schema/versions            — Schema 版本列表
 * GET    /tables/:tableId/schema/versions/:version   — Schema 快照
 * POST   /tables/:tableId/fields                     — 创建字段
 * PATCH  /fields/:fieldId                            — 更新字段（删掉被应用引用的选项 → 409 used_by_apps，confirm: true 继续）
 * POST   /fields/:fieldId/archive                    — 归档字段（被应用引用 → 409 used_by_apps，{confirm:true} 继续）
 * POST   /fields/:fieldId/ai/fill                    — AI 字段：为空白单元格入队（TableAiFieldRunResult；阶段 2 占位，切片 AI）
 * POST   /fields/:fieldId/ai/regenerate              — AI 字段：全部或 {recordIds} 重新生成（受字段月度上限；同上）
 * GET    /fields/:fieldId/ai/status                  — AI 字段：进度、本月用量、?recordIds= 的单元格状态（TableAiFieldStatusView；同上）
 * POST   /schema-plan/apply                          — 应用一份已确认的搭建计划（retry: true = 只重试未完成项）
 *
 * 视图（./views.ts）
 * GET    /tables/:tableId/views                      — 视图列表
 * POST   /tables/:tableId/views                      — 创建视图
 * PATCH  /views/:viewId                              — 更新视图（可改类型）
 * DELETE /views/:viewId                              — 删除视图（硬删：本人个人视图 editor+ / 共享视图 builder）
 *
 * 表单（./forms.ts；面向受众的只提交入口是 /api/forms，见 routes/forms.ts）
 * GET    /tables/:tableId/forms                      — 表单列表（builder）
 * POST   /tables/:tableId/forms                      — 创建表单
 * GET    /forms/:formId                              — 读取表单 + 字段（自定义角色：只含可编辑字段、可读字段的预填，无受众）
 * PATCH  /forms/:formId                              — revision 更新表单
 *
 * 记录（./records.ts；/records/deleted 必须注册在 /records/:recordId 之前）
 * POST   /tables/:tableId/records/query              — 查询记录（body = TableQuery + 可选 `timezone`：日期令牌与按天比较用查看者时区）
 * POST   /tables/:tableId/records/aggregate          — 聚合（视图的分组 / 看板列计数）
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
 * 动态与评论（./activity.ts；能读记录就能看动态、发评论，字段变更按读者可读字段裁剪）
 * GET    /tables/:tableId/records/:recordId/activity  — 评论 + 历史合并，新的在前（?cursor=&limit=≤50）
 * POST   /tables/:tableId/records/:recordId/comments  — 发评论（Markdown ≤10k，`[@名字](user:<id>)` 提及并通知）
 * PATCH  /comments/:commentId                        — 改评论（仅作者；新增的提及才通知）
 * DELETE /comments/:commentId                        — 删评论（作者或 Base builder+，软删）
 *
 * 自动化（./automations.ts；Webhook 动作与密钥只能经这里由人设置）
 * GET    /bases/:baseId/automations                  — 自动化规则列表（builder，Webhook 只带 hasSecret）
 * POST   /bases/:baseId/automations                  — 创建规则（执行者 = 保存者）
 * PATCH  /automations/:automationId                  — revision 更新规则（改触发 / 条件 / 动作时执行者改为保存者）
 * DELETE /automations/:automationId                  — 删除规则（builder，连带运行记录；被应用动作引用 → 409 used_by_apps，?confirm=1 继续）
 * GET    /automations/:automationId/runs             — 运行记录（逐步日志）
 * POST   /automations/:automationId/trigger          — 按下记录上的按钮（{recordId, requestId}，排队异步执行）
 * GET    /tables/:tableId/records/:recordId/buttons  — 该记录上当前用户能按的按钮
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
import { accessRoutes } from './access.js';
import { activityRoutes } from './activity.js';
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
  .route('/', accessRoutes)
  .route('/', schemaRoutes)
  .route('/', viewRoutes)
  .route('/', formRoutes)
  .route('/', recordRoutes)
  .route('/', importRoutes)
  .route('/', activityRoutes)
  .route('/', automationRoutes)
  .route('/', dashboardRoutes);

export default tablesRoutes;
