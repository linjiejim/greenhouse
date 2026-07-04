/**
 * Framework chrome strings, registered into the shared i18n registry under the
 * `crud.*` namespace at import time (like the fork locale seam). Importing the
 * client barrel wires these before any CrudPage renders. Schema-authored labels
 * are the app's concern; these are only the framework's own buttons/empty-states.
 */

import { registerLocaleMessages } from '@greenhouse/ui/lib/i18n';

registerLocaleMessages('en', {
  crud: {
    add: 'Add',
    edit: 'Edit',
    view: 'View',
    delete: 'Delete',
    create: 'Create',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    search: 'Search',
    filters: 'Filters',
    moreFilters: 'More',
    reset: 'Reset',
    total: '{count} total',
    empty: 'No records found',
    loadFailed: 'Failed to load',
    saveFailed: 'Failed to save',
    deleteFailed: 'Failed to delete',
    deleted: 'Deleted',
    saved: 'Saved',
    created: 'Created',
    updated: 'Updated',
    confirmDeleteTitle: 'Delete this record?',
    confirmDeleteBody: 'This action cannot be undone.',
    required: 'This field is required',
    actions: 'Actions',
    close: 'Close',
    all: 'All',
  },
});

registerLocaleMessages('zh', {
  crud: {
    add: '新增',
    edit: '编辑',
    view: '查看',
    delete: '删除',
    create: '创建',
    save: '保存',
    saving: '保存中…',
    cancel: '取消',
    search: '搜索',
    filters: '筛选',
    moreFilters: '更多',
    reset: '重置',
    total: '共 {count} 条',
    empty: '暂无数据',
    loadFailed: '加载失败',
    saveFailed: '保存失败',
    deleteFailed: '删除失败',
    deleted: '已删除',
    saved: '已保存',
    created: '已创建',
    updated: '已更新',
    confirmDeleteTitle: '确认删除这条记录？',
    confirmDeleteBody: '此操作无法撤销。',
    required: '此项为必填',
    actions: '操作',
    close: '关闭',
    all: '全部',
  },
});
