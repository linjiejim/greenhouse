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
      shared: '分发给我的',
      sharedHint: '分发给你、你所在群组或全员的已发布应用',
      featured: '推荐',
      featuredHint: '由管理员推荐，所有能打开的人都会看到',
    },
    emptyTitle: '还没有应用',
    emptyDescription: '应用把一个 Base 变成为某件事准备的页面——申请表单、审批看板、报表——并分发给使用它的人。',
    emptyViewerDescription: '分发给你、你所在群组或全员的应用会出现在这里。',
    version: 'v{version}',
    notPublished: '尚未发布',
    open: '打开 {name}',
    edit: '编辑 {name}',
    noDescription: '暂无描述',
    pin: '把 {name} 置顶到侧栏',
    unpin: '取消置顶 {name}',
    pinFailed: '无法更新置顶的应用',
    askBot: {
      entry: '让 Agent 搭一个',
      title: '让 Agent 搭一个应用',
      hint: 'Chat 会带着你的需求打开。Agent 把表和页面写成方案，你确认后才会真正搭建。',
      base: '在哪个 Base 上',
      newBase: '新的 Base（由 Agent 提议）',
      goal: '这个应用要做什么？',
      goalPlaceholder: '例如：采购申请，由财务审批，并按月出报表',
      open: '打开 Chat',
      prompt: '在我的 Base「{base}」（Base #{id}）上搭一个应用，用于：{goal}',
      promptNewBase: '新建一个 Base 并搭一个应用，用于：{goal}',
    },
    templates: {
      title: '从模板新建',
      note: '模板会新建一个归你所有的 Base（含模板的表）和其上的一个草稿应用——可以调整后再发布。',
      use: '使用这个模板',
      installing: '正在创建…',
      failed: '无法安装模板',
    },
  },
};
