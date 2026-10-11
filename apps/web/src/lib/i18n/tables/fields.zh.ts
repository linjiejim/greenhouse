/** Tables · 字段设置：单选 / 多选的选项列表。由 ./zh.ts 并入 `tables`。 */

import type { DeepRecord } from '../types';
import type { tablesFieldsEn } from './fields.en';

export const tablesFieldsZh: DeepRecord<typeof tablesFieldsEn> = {
  fieldOptions: {
    title: '选项',
    hint: '在这里改名、排序或删除选项；记录始终指向同一个选项。',
    label: '选项 {index}',
    add: '添加选项',
    moveUp: '上移「{name}」',
    moveDown: '下移「{name}」',
    remove: '删除「{name}」',
  },
};
