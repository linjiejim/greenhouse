/**
 * Apps · the builder (`#/apps/<id>/edit`): pages, canvas, properties, roles, audiences, publishing.
 * Owned by slice B; spread into `apps` by ./zh.ts (keys resolve as `apps.builder.*`).
 */

import type { DeepRecord } from '../types';
import type { appsBuilderEn } from './builder.en';

export const appsBuilderZh: DeepRecord<typeof appsBuilderEn> = {
  builder: {
    title: '编辑 {name}',
    unavailableTitle: '应用构建器暂不可用',
    unavailableDescription: '当前版本的 Greenhouse 还不能编辑应用的页面、角色和受众。已发布的应用照常可用。',
    openApp: '打开应用',
  },
};
