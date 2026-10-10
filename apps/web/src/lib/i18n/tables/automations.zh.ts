/**
 * Tables · Automations: rule editor, triggers, actions and the run log.
 * Owned by slice Au; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesAutomationsEn } from './automations.en';

export const tablesAutomationsZh: DeepRecord<typeof tablesAutomationsEn> = {
  automations: {
    title: '自动化',
    description: '规则以创建者身份执行，并会在每次运行前重新检查其 Base 编辑权限。',
    loadFailed: '无法加载自动化',
    createFailed: '无法创建自动化',
    updateFailed: '无法更新自动化',
    loadRunsFailed: '无法加载运行记录',
    ruleName: '规则名称',
    ruleNamePlaceholder: '例如：新记录创建时通知负责人',
    table: '数据表',
    trigger: '触发条件',
    recordCreated: '记录已创建',
    recordUpdated: '记录已更新',
    enableImmediately: '立即启用',
    notifyTeammates: '通知团队成员',
    notificationTitle: '通知标题',
    message: '消息',
    createRule: '创建规则',
    newAutomation: '新建自动化',
    emptyTitle: '暂无自动化',
    emptyDescription: '为记录事件和内部通知创建确定性规则。',
    tableNumber: '数据表 #{id}',
    revision: '修订版 {revision}',
    runs: '运行记录',
    noRuns: '暂无运行记录。',
    runSummary: '运行 #{id} · {status} · {count} 个操作',
  },
};
