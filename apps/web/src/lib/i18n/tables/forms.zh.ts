/**
 * Tables · Forms: builder dialog and the submit page (`#/forms/:id`).
 * Owned by slice Fm; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesFormsEn } from './forms.en';

export const tablesFormsZh: DeepRecord<typeof tablesFormsEn> = {
  forms: {
    title: '表单',
    loadFailed: '无法加载表单',
    createFailed: '无法创建表单',
    updateFailed: '无法更新表单',
    internalName: '内部名称',
    internalNamePlaceholder: '例如：项目登记',
    formTitle: '表单标题',
    formTitlePlaceholder: '展示给团队成员',
    publishedFields: '发布字段',
    createDraft: '创建草稿',
    newForm: '新建表单',
    emptyTitle: '暂无表单',
    emptyDescription: '创建表单以收集团队成员提交的结构化记录。',
    submit: '提交',
    responseRecorded: '你的回复已记录。',
    summary: '{count} 个字段 · 修订版 {revision}',
    unpublish: '取消发布',
    publish: '发布',
    copyLink: '复制内部表单链接',
    openForm: '打开表单',
    choose: '请选择…',
    loadOneFailed: '无法加载表单',
    submitFailed: '无法提交表单',
    unavailable: '表单不可用',
    notFound: '未找到此表单。',
    notPublished: '表单尚未发布',
    notPublishedHint: '请联系构建者发布此内部表单。',
    responseRecordedTitle: '回复已记录',
    submitAnother: '再提交一份回复',
    internalForm: '内部表单',
    submitting: '提交中…',
  },
};
