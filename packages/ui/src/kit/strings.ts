/**
 * Every word the kit prints or announces by itself, in zh and en (docs/design-system/content.md,
 * 中英文: all copy lives in a dictionary). Components read the active set through KitProvider;
 * without a provider they speak zh. Words the caller passes in (labels, options, status words)
 * are the caller's to translate.
 */

export type KitLocale = 'zh' | 'en';

export interface KitStrings {
  /** Default name of a "⋯" menu. */
  more: string;
  /** Default name of a right-click menu. */
  actions: string;
  /** Placeholder of a Select or MultiSelect without a value. */
  choose: string;
  search: string;
  searchOptions: string;
  clearSearch: string;
  noMatches: string;
  selectedCount: (count: number) => string;
  clear: string;
  /** Names the clear button of a date field: "清除截止日期". */
  clearValue: (label: string) => string;
  /** Accessible name of a date field that has a value: "截止日期：10 月 16 日 周五". */
  labelWithValue: (label: string, value: string) => string;
  today: string;
  chooseDate: string;
  chooseRange: string;
  pickStart: string;
  pickEnd: string;
  previousMonth: string;
  nextMonth: string;
  /** Calendar title: "2026 年 10 月". */
  month: (date: Date) => string;
  /** Calendar column heads, Monday first. */
  weekdays: readonly string[];
  /** A calendar cell's name: "10 月 16 日 星期五". */
  day: (date: Date) => string;
  /** A date in a field: "10 月 16 日 周五"; "2025 年 10 月 3 日" outside this year. */
  date: (date: Date, withYear: boolean) => string;
  rangeSeparator: string;
  /** Name of a "?" button. */
  help: (label: string) => string;
  required: string;
  close: string;
  closeDetails: string;
  dismissOverlay: string;
  dragToClose: string;
  dismissToast: string;
  cancel: string;
  save: string;
  configured: string;
  replace: string;
  pasteKey: string;
  retry: string;
  loading: string;
  nothingHere: string;
  /** Default name of a Tabs strip. */
  views: string;
}

/** Monday-first weekday index (0 = Monday). */
export const weekdayIndex = (date: Date) => (date.getDay() + 6) % 7;

const ZH_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;

const zh: KitStrings = {
  more: '更多',
  actions: '操作',
  choose: '请选择',
  search: '搜索',
  searchOptions: '搜索选项',
  clearSearch: '清除搜索',
  noMatches: '没有匹配的选项',
  selectedCount: (count) => `已选 ${count}`,
  clear: '清除',
  clearValue: (label) => `清除${label}`,
  labelWithValue: (label, value) => `${label}：${value}`,
  today: '今天',
  chooseDate: '选择日期',
  chooseRange: '选择日期范围',
  pickStart: '先选开始日期',
  pickEnd: '再选结束日期',
  previousMonth: '上个月',
  nextMonth: '下个月',
  month: (date) => `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`,
  weekdays: ZH_WEEKDAYS,
  day: (date) => `${date.getMonth() + 1} 月 ${date.getDate()} 日 星期${ZH_WEEKDAYS[weekdayIndex(date)]}`,
  date: (date, withYear) =>
    withYear
      ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
      : `${date.getMonth() + 1} 月 ${date.getDate()} 日 周${ZH_WEEKDAYS[weekdayIndex(date)]}`,
  rangeSeparator: ' – ',
  help: (label) => `说明：${label}`,
  required: '必填',
  close: '关闭',
  closeDetails: '关闭详情',
  dismissOverlay: '关闭弹框',
  dragToClose: '下拉关闭详情',
  dismissToast: '关闭提示',
  cancel: '取消',
  save: '保存',
  configured: '已配置',
  replace: '替换',
  pasteKey: '粘贴新的 Key',
  retry: '重试',
  loading: '正在加载',
  nothingHere: '这里还没有内容',
  views: '视图',
};

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const EN_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const en: KitStrings = {
  more: 'More',
  actions: 'Actions',
  choose: 'Choose',
  search: 'Search',
  searchOptions: 'Search options',
  clearSearch: 'Clear search',
  noMatches: 'No matching options',
  selectedCount: (count) => `${count} selected`,
  clear: 'Clear',
  clearValue: (label) => `Clear ${label}`,
  labelWithValue: (label, value) => `${label}: ${value}`,
  today: 'Today',
  chooseDate: 'Choose a date',
  chooseRange: 'Choose dates',
  pickStart: 'Pick the start date',
  pickEnd: 'Now pick the end date',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  month: (date) => `${EN_MONTHS[date.getMonth()]} ${date.getFullYear()}`,
  weekdays: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
  day: (date) => `${EN_WEEKDAYS[weekdayIndex(date)]}, ${EN_MONTHS[date.getMonth()]} ${date.getDate()}`,
  date: (date, withYear) =>
    withYear
      ? `${EN_MONTHS[date.getMonth()].slice(0, 3)} ${date.getDate()}, ${date.getFullYear()}`
      : `${EN_WEEKDAYS[weekdayIndex(date)].slice(0, 3)}, ${EN_MONTHS[date.getMonth()].slice(0, 3)} ${date.getDate()}`,
  rangeSeparator: ' – ',
  help: (label) => `About ${label}`,
  required: 'Required',
  close: 'Close',
  closeDetails: 'Close details',
  dismissOverlay: 'Close',
  dragToClose: 'Drag down to close',
  dismissToast: 'Dismiss',
  cancel: 'Cancel',
  save: 'Save',
  configured: 'Configured',
  replace: 'Replace',
  pasteKey: 'Paste a new key',
  retry: 'Try again',
  loading: 'Loading',
  nothingHere: 'Nothing here yet',
  views: 'Views',
};

export const kitStrings: Record<KitLocale, KitStrings> = { zh, en };
