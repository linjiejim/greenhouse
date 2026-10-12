/**
 * Apps · the app center (`#/apps`): shelves, entry points, empty states, the create dialogs.
 * Owned by slice R; spread into `apps` by ./zh.ts (keys resolve as `apps.center.*`).
 */

import type { DeepRecord } from '../types';
import type { appsCenterEn } from './center.en';

export const appsCenterZh: DeepRecord<typeof appsCenterEn> = {
  center: {
    loadFailed: '无法加载你的应用',
    newApp: '新建应用',
    fromTemplate: '从模板新建',
    shelf: {
      managed: '我管理的',
      managedHint: '你拥有或参与搭建的 Base 上的应用，包含草稿',
      shared: '与我共享',
      sharedHint: '分发给你、你所在群组或全员的已发布应用',
      featured: '推荐',
      featuredHint: '由管理员推荐，所有能打开的人都会看到',
    },
    emptyTitle: '还没有应用',
    emptyDescription: '新建应用，或从模板开始。',
    emptyViewerDescription: '与你共享的应用会显示在这里。',
    version: 'v{version}',
    open: '打开 {name}',
    edit: '编辑 {name}',
    pin: '把 {name} 置顶到侧栏',
    unpin: '取消置顶 {name}',
    pinFailed: '无法更新置顶的应用',
    askBot: {
      entry: '用 Agent 创建',
      title: '用 Agent 创建应用',
      hint: '先在对话中完善需求，确认方案后再创建。',
      base: '数据来源',
      newBase: '新建数据空间',
      goal: '这个应用要做什么？',
      goalPlaceholder: '例如：采购申请，由财务审批，并按月出报表',
      open: '继续到对话',
      prompt: '在我的 Base「{base}」（Base #{id}）上搭一个应用，用于：{goal}',
      promptNewBase: '新建一个 Base 并搭一个应用，用于：{goal}',
    },
    templates: {
      title: '从模板新建',
      note: '将创建私有数据空间和应用草稿。自动化默认关闭，配置后再发布。',
      use: '选择模板',
      back: '重新选择',
      installing: '正在创建…',
      failed: '无法安装模板',
    },
  },
};
