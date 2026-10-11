/**
 * Tables · the schema-plan card (`tablesSchemaPlan.*`), including the label of every plan
 * operation kind. Owned by slice P; assigned to `tablesSchemaPlan` by ./zh.ts.
 */

import type { DeepRecord } from '../types';
import type { tablesPlanEn } from './plan.en';

export const tablesPlanZh: DeepRecord<typeof tablesPlanEn> = {
  title: '表结构变更',
  opsCount: '{count} 项变更',
  tally: '成功 {applied} · 失败 {failed} · 跳过 {skipped}',
  required: '必填',
  opBaseCreate: '新建 Base',
  opBaseUpdate: '修改 Base',
  opTableCreate: '新建表',
  opTableUpdate: '修改表',
  opFieldCreate: '新增字段',
  opFieldUpdate: '修改字段',
  opFieldArchive: '归档字段',
  opViewCreate: '新建视图',
  opViewUpdate: '修改视图',
  opFormCreate: '新建表单',
  opFormUpdate: '修改表单',
  opAutomationCreate: '新建自动化',
  opAutomationUpdate: '修改自动化',
  opDashboardCreate: '新建仪表盘',
  opDashboardUpdate: '修改仪表盘',
  opWidgetCreate: '添加组件',
  opWidgetUpdate: '修改组件',
  opWidgetDelete: '删除组件',
  opRoleCreate: '新建角色',
  opRoleUpdate: '修改角色',
  opMemberSet: '设置成员权限',
  hint: '尚未创建任何内容。确认后才会执行这些变更。',
  dismissedHint: '已忽略，未做任何修改。',
  appliedHint: '已执行。再次确认会创建重复内容。',
  confirm: '确认',
  dismiss: '忽略',
  applying: '执行中…',
  openBase: '打开 Base',
  appliedToast: '结构已更新',
  partialToast: '有 {count} 项变更未能执行',
  applyFailed: '结构变更执行失败',
  reviewStatus: '待确认',
  dismissedStatus: '已忽略',
  partialStatus: '需处理',
};
