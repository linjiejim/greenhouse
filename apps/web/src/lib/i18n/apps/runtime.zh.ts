/**
 * Apps · the runtime (`#/apps/<id>[/<pageId>]`): the app shell, pages, cards, record drawer.
 * Owned by slice R; spread into `apps` by ./zh.ts (keys resolve as `apps.runtime.*`).
 */

import type { DeepRecord } from '../types';
import type { appsRuntimeEn } from './runtime.en';

export const appsRuntimeZh: DeepRecord<typeof appsRuntimeEn> = {
  runtime: {
    loadFailed: '无法加载这个应用',
    notFoundTitle: '应用不可用',
    notFoundDescription: '它不存在、已归档，或没有分发给你。',
    invalidRoute: '这个应用地址无效。',
    backToCenter: '全部应用',
    pagesTitle: '页面',
    pageMissing: '这个应用里没有这个页面。',
    pagesUnavailableTitle: '页面暂时无法在这里显示',
    pagesUnavailableDescription: '当前版本的 Greenhouse 只能列出应用的页面，还不能显示其中的卡片。',
    notPublishedTitle: '尚未发布',
    notPublishedDescription: '发布第一个版本后，使用者才能看到这个应用。',
    managerView: '完整访问',
  },
};
