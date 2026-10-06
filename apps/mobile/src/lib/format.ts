/**
 * Formatting helpers + friendly (localized) label/icon maps shared across
 * screens: timestamps (Hermes-safe parsing), greetings, tool and source-category
 * names, compact numbers.
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

/** Time-of-day greeting prefix. */
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return t('home.greetingDawn');
  if (h < 12) return t('home.greetingMorning');
  if (h < 14) return t('home.greetingNoon');
  if (h < 18) return t('home.greetingAfternoon');
  return t('home.greetingEvening');
}

/** Server tools with a friendly name in the catalogs (`tools.*`, mirrors web TOOL_BRIEFS). */
const TOOL_KEYS = [
  'search',
  'get_page',
  'update_page',
  'knowledge_query',
  'knowledge_mutation',
  'external_search',
  'web_search',
  'ask_user',
  'ecommerce',
  'analyze_image',
  'generate_image',
  'project_manager',
  'email_manager',
  'feature_request',
  'compute',
  'export_table',
] as const;
type ToolKey = (typeof TOOL_KEYS)[number];
const isToolKey = (name: string): name is ToolKey => (TOOL_KEYS as readonly string[]).includes(name);

/** Friendly, localized name for a server tool (falls back to the raw name). */
export function toolLabel(name: string): string {
  return isToolKey(name) ? t(`tools.${name}`) : name;
}

/** SF-symbol per tool (best-effort, mirrors web TOOL_ICONS). */
const TOOL_ICONS: Record<string, IconName> = {
  search: 'book',
  get_page: 'file',
  update_page: 'pen',
  knowledge_query: 'book',
  knowledge_mutation: 'pen',
  external_search: 'globe',
  web_search: 'globe',
  ask_user: 'msg',
  ecommerce: 'bar',
  analyze_image: 'image',
  generate_image: 'image',
  project_manager: 'folder',
  email_manager: 'msg',
  feature_request: 'flag',
  compute: 'bar',
  export_table: 'table',
};

export function toolIcon(name: string): IconName {
  return TOOL_ICONS[name] ?? 'wrench';
}

/** Source category → localized label / icon (`sourceCat.*`). */
const CAT_KEYS = ['wiki', 'doc', 'data', 'web', 'source', 'team', 'public', 'personal'] as const;
type CatKey = (typeof CAT_KEYS)[number];
const isCatKey = (cat: string): cat is CatKey => (CAT_KEYS as readonly string[]).includes(cat);

const CAT_ICONS: Record<CatKey, IconName> = {
  wiki: 'book',
  doc: 'file',
  data: 'bar',
  web: 'globe',
  source: 'book',
  team: 'users',
  public: 'globe',
  personal: 'lock',
};

export function catLabel(cat?: string): string {
  return cat && isCatKey(cat) ? t(`sourceCat.${cat}`) : t('sourceCat.other');
}
export function catIcon(cat?: string): IconName {
  return (cat && isCatKey(cat) && CAT_ICONS[cat]) || 'file';
}

/** Compact count: 1234 → "1.2k". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${Math.round(n / 1_000_000)}M`;
}
