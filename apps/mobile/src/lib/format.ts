/**
 * Formatting helpers + friendly label/icon maps shared across screens.
 */

import type { IconName } from '../ui/core';
import { t } from './i18n';

/**
 * Parse a timestamp to ms. Normalizes Postgres-style strings like
 * "2026-06-08 05:05:34.202+00" (space instead of T, "+00" instead of "+00:00")
 * which Hermes' strict Date parser rejects (returns Invalid Date) even though
 * browsers accept them — the reason times rendered on web but not on mobile.
 */
export function parseMs(iso?: string | null): number {
  if (!iso) return NaN;
  let s = String(iso).trim().replace(' ', 'T');
  // "+00" → "+00:00", "+0800" → "+08:00"; leave "+08:00" / "Z" untouched.
  s = s.replace(/([+-]\d{2})(\d{2})?$/, (_m, hh: string, mm?: string) => `${hh}:${mm || '00'}`);
  let t = Date.parse(s);
  if (Number.isNaN(t)) t = Date.parse(iso);
  return t;
}

export function relativeTime(iso?: string | null): string {
  const d = parseMs(iso);
  if (Number.isNaN(d)) return '';
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('time.justNow');
  if (m < 60) return t('time.minutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.hoursAgo', { n: h });
  const days = Math.floor(h / 24);
  if (days === 1) return t('time.yesterday');
  if (days < 7) return t('time.daysAgo', { n: days });
  return new Date(d).toLocaleDateString();
}

/** Compact relative time, mirrors web (`3m` / `2h` / `5d` / `3mo` / `1y`). */
export function shortTime(iso?: string | null): string {
  const then = parseMs(iso);
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 0) return 'now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

/** Time-of-day greeting prefix. */
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return t('home.greetingDawn');
  if (h < 12) return t('home.greetingMorning');
  if (h < 14) return t('home.greetingNoon');
  if (h < 18) return t('home.greetingAfternoon');
  return t('home.greetingEvening');
}

/** Friendly Chinese names for server tools (mirrors web TOOL_BRIEFS in @greenhouse/ui icons.ts). */
export const TOOL_LABELS: Record<string, string> = {
  search: '检索知识',
  get_page: '查看文档',
  update_page: '更新文档',
  knowledge_query: '检索知识',
  knowledge_mutation: '更新知识',
  external_search: '联网搜索',
  ask_user: '向你提问',
  ecommerce: '查询电商数据',
  analyze_image: '分析图片',
  generate_image: '生成图片',
  project_manager: '项目管理',
  email_manager: '邮件',
  feature_request: '需求反馈',
  compute: '计算',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** Lucide icon per tool (best-effort, mirrors web TOOL_ICONS). */
export const TOOL_ICONS: Record<string, IconName> = {
  search: 'book',
  get_page: 'file',
  update_page: 'file',
  knowledge_query: 'book',
  knowledge_mutation: 'book',
  external_search: 'globe',
  ask_user: 'file',
  ecommerce: 'bar',
  analyze_image: 'image',
  generate_image: 'image',
  project_manager: 'folder',
  email_manager: 'file',
  feature_request: 'file',
  compute: 'bar',
};

export function toolIcon(name: string): IconName {
  return TOOL_ICONS[name] ?? 'file';
}

/** Source category → label / icon. */
export const CAT_LABELS: Record<string, string> = {
  wiki: '知识库',
  doc: '文档',
  data: '业务数据',
  web: '网页',
  source: '知识源',
  team: '团队知识',
  public: '对外资料',
  personal: '个人知识',
};
export const CAT_ICONS: Record<string, IconName> = {
  wiki: 'book',
  doc: 'file',
  data: 'bar',
  web: 'globe',
  source: 'book',
  team: 'book',
  public: 'book',
  personal: 'book',
};
export function catLabel(cat?: string): string {
  return (cat && CAT_LABELS[cat]) || '资料';
}
export function catIcon(cat?: string): IconName {
  return (cat && CAT_ICONS[cat]) || 'file';
}
