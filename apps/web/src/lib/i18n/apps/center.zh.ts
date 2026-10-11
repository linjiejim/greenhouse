/**
 * Apps · the app center (`#/apps`): shelves, entry points, empty states.
 * Owned by slice C (center); spread into `apps` by ./zh.ts (keys resolve as `apps.center.*`).
 */

import type { DeepRecord } from '../types';
import type { appsCenterEn } from './center.en';

export const appsCenterZh: DeepRecord<typeof appsCenterEn> = {
  center: {
    loadFailed: '无法加载你的应用',
    newApp: '新建应用',
    askBot: '让 Bot 搭一个',
    fromTemplate: '从模板新建',
    entryUnavailable: '暂不可用——搭建应用将随应用构建器一起开放。',
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
    version: 'v{version}',
    notPublished: '尚未发布',
    open: '打开 {name}',
    edit: '编辑 {name}',
    noDescription: '暂无描述',
    pin: '把 {name} 置顶到侧栏',
    unpin: '取消置顶 {name}',
    pinFailed: '无法更新置顶的应用',
  },
};
