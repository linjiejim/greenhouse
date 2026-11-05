/** The kit's own words. Pages bring theirs; these cover the shared parts. */
import { useEmbed } from './embed.js';

const zh = {
  close: '关闭',
  cancel: '取消',
  retry: '重试',
  clearFilters: '清除筛选',
  discardTitle: '放弃未保存的修改？',
  discard: '放弃修改',
  keepEditing: '继续编辑',
  loadFailed: '加载失败',
  loadFailedHint: '请检查网络后重试。',
  noMatch: '没有符合条件的结果',
  noPermission: '你没有查看权限',
  noPermissionHint: '需要权限时，请联系管理员。',
  hostMissing: '没有连上 Greenhouse',
  hostMissingHint: '请在 Greenhouse 里打开这一页，或刷新后重试。',
  choose: '请选择',
  noOptions: '没有可选项',
  required: '必填',
  labelSep: '：',
};
const en: typeof zh = {
  close: 'Close',
  cancel: 'Cancel',
  retry: 'Retry',
  clearFilters: 'Clear filters',
  discardTitle: 'Discard unsaved changes?',
  discard: 'Discard',
  keepEditing: 'Keep editing',
  loadFailed: "Couldn't load",
  loadFailedHint: 'Check your connection and retry.',
  noMatch: 'No results match',
  noPermission: "You don't have access",
  noPermissionHint: 'Ask an administrator if you need it.',
  hostMissing: "Couldn't reach Greenhouse",
  hostMissingHint: 'Open this page inside Greenhouse, or reload and retry.',
  choose: 'Choose',
  noOptions: 'Nothing to choose',
  required: 'Required',
  labelSep: ': ',
};
export type KitStrings = typeof zh;

export function useKitStrings(): KitStrings {
  return useEmbed().locale === 'en' ? en : zh;
}
