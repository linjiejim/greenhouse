/**
 * Tables · A record's activity tab: comments, mentions and change history.
 * Owned by slice C; spread into `tables` by ./zh.ts (keys resolve as `tables.<namespace>.*`).
 */

import type { DeepRecord } from '../types';
import type { tablesActivityEn } from './activity.en';

export const tablesActivityZh: DeepRecord<typeof tablesActivityEn> = {
  activity: {
    tab: '动态',
    timeline: '记录动态',
    loadFailed: '无法加载动态',
    retry: '重试',
    emptyTitle: '还没有动态',
    emptyDescription: '这条记录的修改与评论会显示在这里。',
    loadOlder: '查看更早的动态',
    someone: '某人',
    created: '{actor} 创建了这条记录',
    updated: '{actor} 修改了这条记录',
    deleted: '{actor} 删除了这条记录',
    restored: '{actor} 恢复了这条记录',
    noVisibleChanges: '没有你可见的字段被填写。',
    viaForm: '通过表单 #{id}',
    viaImport: '通过导入',
    viaRule: '由规则 #{id}',
    viaApp: '在应用 #{id} 中',
    actorKind: {
      user: '成员',
      agent: 'Agent',
      automation: '自动化',
      form: '表单',
      import: '导入',
      app: '应用',
      system: '系统',
    },
    edited: '已编辑',
    editComment: '编辑评论',
    deleteComment: '删除评论',
    deleteConfirm: '删除这条评论？',
    deleteDescription: '所有能看到这条记录的人都将看不到它。',
    commentDeleted: '评论已删除',
    composerLabel: '评论',
    composerPlaceholder: '写评论——输入 @ 提及同事',
    composerHint: 'Ctrl / ⌘ + Enter 发送。只有能打开这条记录的人会收到通知。',
    post: '评论',
    postFailed: '评论发送失败',
    updateFailed: '评论更新失败',
    deleteFailed: '评论删除失败',
    tooLong: '评论最多 {max} 个字符。',
    cannotComment: '你不能评论这条记录。',
    mentionList: '可提及的成员',
    mentionNoMatch: '没有匹配的成员',
  },
};
