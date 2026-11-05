/** React-free declarative surface protocol. Never trust framed page messages or URLs. */
import type {
  EmbedConfirmRequest,
  EmbedHeaderAction,
  EmbedNotifyRequest,
  EntityFieldSchema,
  EntityViewSchema,
  PluginEntitySchema,
} from '../shared/plugins';
import { categorical } from '../theme/palette';
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
/** `names`: member id → name (src/store/people.ts); an unknown member stays its id. */
/**
 * An instant from ISO or Postgres text ("2026-10-27 08:35:36.094111+00"); Hermes' Date.parse
 * refuses the space, the microseconds and the bare "+00" offset that V8 accepts.
 */
export function parseInstant(text: string): number {
  const pg = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
    text.trim(),
  );
  if (!pg) return Date.parse(text);
  const [, day, clock, fraction, zone] = pg;
  const offset = !zone
    ? ''
    : /^z$/i.test(zone)
      ? 'Z'
      : zone.length === 3
        ? `${zone}:00`
        : zone.includes(':')
          ? zone
          : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return Date.parse(
    `${day}T${clock.length === 5 ? `${clock}:00` : clock}${fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : ''}${offset}`,
  );
}
export function fieldText(
  field: EntityFieldSchema,
  value: unknown,
  locale: 'zh' | 'en',
  names: Readonly<Record<string, string>> = {},
): string {
  if (value == null) return '—';
  if (field.kind === 'user' && typeof value === 'string') return names[value] ?? value;
  if (field.kind === 'boolean') return value ? (locale === 'zh' ? '是' : 'Yes') : locale === 'zh' ? '否' : 'No';
  if (field.kind === 'date' || field.kind === 'dateTime') {
    const day = field.kind === 'date' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    const time = day
      ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime()
      : parseInstant(String(value));
    // medium date, minutes not seconds: "Oct 27, 2026, 9:54 AM" / "2026年10月27日 09:54"
    if (Number.isFinite(time))
      return new Intl.DateTimeFormat(
        locale,
        field.kind === 'date' ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' },
      ).format(new Date(time));
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
  initial?: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    entity.fields
      .filter((f) => f.writable === true && Object.hasOwn(draft, f.key))
      .filter((f) => {
        if (!initial) return true;
        // Compare the displayed draft too, preserving null/empty and timestamp precision on untouched inputs.
        const displayed =
          f.kind === 'boolean'
            ? Boolean(initial[f.key])
            : f.kind === 'json'
              ? JSON.stringify(initial[f.key] ?? null)
              : String(initial[f.key] ?? '');
        return draft[f.key] !== displayed;
      })
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
      })
      .filter(([key, value]) => !initial || JSON.stringify(value) !== JSON.stringify(initial[String(key)])),
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
  | { type: 'greenhouse:sendPrompt'; text: string }
  | ({ type: 'greenhouse:confirm' } & EmbedConfirmRequest)
  | ({ type: 'greenhouse:notify' } & EmbedNotifyRequest)
  | { type: 'greenhouse:header'; actions: EmbedHeaderAction[] }
  | { type: 'greenhouse:route'; route: string };

const shortText = (value: unknown, max = 300): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,64}$/.test(value);

/** The host draws what a page asks for; anything malformed or oversized is dropped. */
function hostRequest(m: Record<string, unknown>): EmbedMessage | null {
  if (m.type === 'greenhouse:confirm') {
    if (!requestId(m.id) || !shortText(m.title) || !shortText(m.confirmLabel, 40)) return null;
    if (m.body !== undefined && !shortText(m.body, 1000)) return null;
    if (m.cancelLabel !== undefined && !shortText(m.cancelLabel, 40)) return null;
    return {
      type: m.type,
      id: m.id,
      title: m.title,
      body: m.body as string | undefined,
      confirmLabel: m.confirmLabel,
      cancelLabel: m.cancelLabel as string | undefined,
      tone: m.tone === 'danger' ? 'danger' : 'default',
    };
  }
  if (m.type === 'greenhouse:notify') {
    const kinds = ['success', 'info', 'warning', 'undo', 'error'] as const;
    const kind = kinds.find((k) => k === m.kind);
    if (!requestId(m.id) || !kind || !shortText(m.text, 500)) return null;
    if (m.actionLabel !== undefined && !shortText(m.actionLabel, 40)) return null;
    return { type: m.type, id: m.id, kind, text: m.text, actionLabel: m.actionLabel as string | undefined };
  }
  if (m.type === 'greenhouse:header') {
    if (!Array.isArray(m.actions) || m.actions.length > 4) return null;
    const actions: EmbedHeaderAction[] = [];
    for (const a of m.actions as Record<string, unknown>[]) {
      if (!a || !requestId(a.id) || !shortText(a.label, 40) || !shortText(a.icon, 40)) return null;
      actions.push({ id: a.id, label: a.label, icon: a.icon, disabled: a.disabled === true });
    }
    return { type: m.type, actions };
  }
  return null;
}
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
  if (m.type === 'greenhouse:confirm' || m.type === 'greenhouse:notify' || m.type === 'greenhouse:header')
    return hostRequest(m);
  if (m.type === 'greenhouse:route')
    return typeof m.route === 'string' && /^#\/[^\s]{0,1000}$/.test(m.route) ? { type: m.type, route: m.route } : null;
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

/**
 * The CSS variables an embed receives: every palette colour as `--gh-<kebab-name>`, plus the
 * category pairs (`--gh-cat-<name>` text on `--gh-cat-<name>-fill`) for tags and select options.
 */
export function embedTokens(hex: Record<string, string>, isDark: boolean): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(hex))
    tokens[`--gh-${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`] = value;
  for (const [name, pair] of Object.entries(categorical[isDark ? 'dark' : 'light'])) {
    tokens[`--gh-cat-${name}`] = pair.fg;
    tokens[`--gh-cat-${name}-fill`] = pair.fill;
  }
  return tokens;
}
