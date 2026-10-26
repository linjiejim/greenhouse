/** React-free declarative surface protocol. Never trust framed page messages or URLs. */
import type { EntityFieldSchema, EntityViewSchema, PluginEntitySchema } from '../shared/plugins';
export type EntityRow = Record<string, unknown> & { id: string };
export function entityQuery(
  entity: PluginEntitySchema,
  view: EntityViewSchema | undefined,
  skip: number,
  filters: Record<string, string>,
  sort?: { field: string; dir: 'asc' | 'desc' },
) {
  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  const selected = sort ?? view?.sort;
  const filter = Object.entries(filters)
    .filter(([key, value]) => value !== '' && fields.get(key)?.filterable && (view?.filters ?? []).includes(key))
    .map(([key, value]) => ({
      key,
      method: 'eq',
      value: [fields.get(key)?.kind === 'boolean' ? value === 'true' : value],
    }));
  const order = selected && fields.get(selected.field)?.sortable ? [{ key: selected.field, order: selected.dir }] : [];
  const query = new URLSearchParams({
    skip: String(Math.max(0, Math.floor(skip))),
    limit: '50',
    sort: JSON.stringify(order),
    filter: JSON.stringify(filter),
  });
  return query.toString();
}
export function entityColumns(entity: PluginEntitySchema, view?: EntityViewSchema) {
  return (view?.columns ?? entity.fields.map((f) => f.key)).flatMap((key) => {
    const field = entity.fields.find((f) => f.key === key);
    return field ? [field] : [];
  });
}
export function fieldText(field: EntityFieldSchema, value: unknown, locale: 'zh' | 'en'): string {
  if (value == null) return '—';
  if (field.kind === 'boolean') return value ? (locale === 'zh' ? '是' : 'Yes') : locale === 'zh' ? '否' : 'No';
  if (field.kind === 'date' || field.kind === 'dateTime') {
    const day = field.kind === 'date' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    const time = day
      ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime()
      : Date.parse(String(value));
    if (Number.isFinite(time))
      return field.kind === 'date' ? new Date(time).toLocaleDateString(locale) : new Date(time).toLocaleString(locale);
  }
  if (['integer', 'number', 'money'].includes(field.kind) && Number.isFinite(Number(value)))
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: field.kind === 'money' ? 2 : 0,
      maximumFractionDigits: field.kind === 'money' ? 2 : 8,
    }).format(Number(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function writableValues(
  entity: PluginEntitySchema,
  draft: Record<string, string | boolean>,
): Record<string, unknown> {
  return Object.fromEntries(
    entity.fields
      .filter((f) => f.writable)
      .map((f) => {
        const v = draft[f.key];
        if (f.required && (v === undefined || v === '')) throw new Error(String(f.key));
        if (v === '' && !f.required) return [f.key, null];
        if (f.kind === 'json') {
          return [f.key, JSON.parse(String(v))];
        }
        if (['number', 'integer', 'money'].includes(f.kind)) {
          const n = Number(v);
          if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) throw new Error(f.key);
          return [f.key, n];
        }
        return [f.key, v];
      }),
  );
}
export function safeEndpoint(endpoint: string): boolean {
  return /^\/api\/(?!\/)[^?#]+$/.test(endpoint) && !endpoint.includes('..') && !endpoint.includes('\\');
}
export function embedUrl(input: string, base: string, theme: string, locale: string): string | null {
  try {
    const u = new URL(input, base);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.origin === new URL(base).origin)) return null;
    if (u.username || u.password) return null;
    u.searchParams.set('theme', theme);
    u.searchParams.set('locale', locale);
    return u.href;
  } catch {
    return null;
  }
}
export type EmbedMessage =
  | { type: 'greenhouse:ready' | 'greenhouse:token-refresh' }
  | { type: 'greenhouse:navigate'; href: string }
  | { type: 'greenhouse:title'; title: string }
  | { type: 'greenhouse:sendPrompt'; text: string };
export function embedMessage(
  raw: unknown,
  origin: string,
  expectedOrigin: string,
  stationBase = expectedOrigin,
): EmbedMessage | null {
  if (origin !== expectedOrigin || !expectedOrigin || expectedOrigin === 'null') return null;
  let value = raw;
  try {
    if (typeof raw === 'string') value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (m.type === 'greenhouse:ready' || m.type === 'greenhouse:token-refresh') return { type: m.type };
  const key =
    m.type === 'greenhouse:navigate'
      ? 'href'
      : m.type === 'greenhouse:title'
        ? 'title'
        : m.type === 'greenhouse:sendPrompt'
          ? 'text'
          : null;
  if (!key || typeof m[key] !== 'string' || (m[key] as string).length > 20000) return null;
  if (key === 'href' && !safeNavigate(m[key] as string, stationBase)) return null;
  return m as EmbedMessage;
}
/** A frame can navigate within its station, including an absolute entity link. */
export function normalizeNavigate(href: string, base: string): string | null {
  if (href.includes('\\') || Array.from(href).some((char) => char.charCodeAt(0) < 32) || href.startsWith('//'))
    return null;
  if (href.startsWith('#/')) return href;
  try {
    const url = new URL(href, base);
    if (
      url.origin !== new URL(base).origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname.startsWith('/api/')
    )
      return null;
    return url.hash.startsWith('#/') ? url.hash : url.pathname + url.search;
  } catch {
    return null;
  }
}
export function safeNavigate(href: string, base = 'https://station.invalid'): boolean {
  return normalizeNavigate(href, base) !== null;
}
