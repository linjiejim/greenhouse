/** Tables · 人员 / 群组选择器（Base 分享、表单受众、自动化收件人、应用受众）。由 ./zh.ts 并入 `tables`。 */

import type { DeepRecord } from '../types';
import type { tablesPrincipalsEn } from './principals.en';

export const tablesPrincipalsZh: DeepRecord<typeof tablesPrincipalsEn> = {
  principals: {
    searchPeople: '搜索成员',
    people: '成员',
    groups: '群组',
    everyone: '工作区全员',
    everyoneHint: '所有内部成员，包括之后加入的人。',
    noPeople: '没有匹配的成员',
    noGroups: '你还不在任何群组里',
    memberCount: '{count} 人',
    managedBy: '成员由 {name} 管理',
    selectedCount: '已选 {count} 项',
    remove: '移除 {name}',
    loadFailed: '无法加载成员和群组',
  },
};
