import type { FieldType, FieldConfig } from '@greenhouse/contract';
import { detailText } from './presentation.js';

const types: Record<FieldType, [string, string]> = {
  text: ['文本', 'Text'],
  long_text: ['长文本', 'Long text'],
  number: ['数字', 'Number'],
  checkbox: ['勾选', 'Checkbox'],
  date: ['日期', 'Date'],
  datetime: ['日期和时间', 'Date and time'],
  single_select: ['单选', 'Single select'],
  multi_select: ['多选', 'Multiple select'],
  member: ['成员', 'Member'],
  url: ['网址', 'URL'],
  email: ['邮箱', 'Email'],
  phone: ['电话', 'Phone'],
  attachment: ['附件', 'Attachment'],
  relation: ['关联记录', 'Related records'],
  parent: ['父记录', 'Parent record'],
  dependency: ['依赖记录', 'Dependencies'],
  formula: ['公式', 'Formula'],
  lookup: ['查找', 'Lookup'],
  rollup: ['汇总', 'Rollup'],
  ai: ['AI 结果', 'AI result'],
};
export const fieldTypeName = (type: FieldType, locale: 'zh' | 'en') => types[type][locale === 'zh' ? 0 : 1];

export function fieldDetails(
  field: { name: string; type?: FieldType; required?: boolean; primary?: boolean; config?: FieldConfig },
  locale: 'zh' | 'en',
) {
  const options = field.config?.options?.map((option) => option.label) ?? [];
  return {
    label: field.name,
    value: [
      field.type ? fieldTypeName(field.type, locale) : '',
      field.primary ? (locale === 'zh' ? '主字段' : 'Primary field') : '',
      field.required === undefined
        ? ''
        : locale === 'zh'
          ? field.required
            ? '必填'
            : '可选'
          : field.required
            ? 'Required'
            : 'Optional',
      options.join(' · '),
      field.config
        ? detailText(Object.fromEntries(Object.entries(field.config).filter(([key]) => key !== 'options')), locale)
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
    ...(options.length ? { chips: options } : {}),
  };
}
