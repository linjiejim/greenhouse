/**
 * Apps · the Agent side: the Assistant's `app-page` context, app plan operations,
 * Bots plan requests and built-in templates.
 * Owned by slice AG; spread into `apps` by ./zh.ts (keys resolve as `apps.agent.*`).
 */

import type { DeepRecord } from '../types';
import type { appsAgentEn } from './agent.en';

export const appsAgentZh: DeepRecord<typeof appsAgentEn> = {
  agent: {
    context: {
      label: '{app} · {page}',
      appOnly: '{app}',
      unnamedApp: '应用 #{id}',
      builderLabel: '{app} · 构建器',
      empty: '问我关于「{app}」的问题——某个页面是做什么的、怎么用。',
      builderEmpty: '问我关于「{app}」的问题——它的页面、角色，以及分发给了谁。',
      explainPage: '解释这个页面',
      explainPagePrompt: '解释应用「{app}」的「{page}」页面是做什么的、怎么用。',
      planPage: '规划一个页面',
      planPagePrompt: '帮我为应用「{app}」规划一个新页面。',
    },
    plan: {
      opAppCreate: '新建应用',
      opAppUpdate: '修改应用草稿',
      opAppAudience: '设置应用受众',
      opAppPublish: '发布应用',
      groupApps: '应用',
      appShape: '{pages} 个页面 · {roles} 个角色',
      accessAudience: '应用 {app} 的受众',
      accessPublish: '发布应用 {app}',
      audienceNobody: '未分发',
      audienceTeam: '团队所有人',
      audienceGroup: '群组 {name}',
      audienceGroupManaged: '群组 {name}（由 {manager} 管理）',
      audienceEntry: '{who} → {role}',
      publishFirst: '未发布',
      publishLive: 'v{version} 在用',
      publishAfter: 'v{version} 上线，{audience}',
      openApp: '打开应用',
    },
    planRequest: {
      title: '{name} 提议修改表格',
      hint: '应用前不会有任何改动；应用时每一步都以你的身份、按你的权限执行。',
      apply: '应用变更',
      decline: '暂不',
      applying: '正在应用…',
      applied: '已应用',
      partial: '部分应用',
      failed: '未应用',
      tally: '成功 {applied} · 失败 {failed} · 跳过 {skipped}',
      linesCount: '{count} 项变更',
      openBase: '打开 Base',
      openApp: '打开应用',
    },
  },
};
