/**
 * How a plugin read surface without its own screen shows its data (./resource-screen*.tsx). React-free.
 * A collection is a list of rows (title, one supporting line, status, tags, a time); a single object
 * (e.g. the computer's status) is a short list of facts.
 */
export type Resource = { kind: 'rows'; rows: ResourceRow[] } | { kind: 'facts'; facts: ResourceFact[] };
export interface ResourceRow {
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  tags: string[];
  time?: string;
}
export interface ResourceFact {
  key: string;
  label: string;
  value: string | number | boolean | null;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function resourceOf(data: unknown, collection?: string): Resource {
  const value = collection && record(data) ? data[collection] : data;
  if (Array.isArray(value)) return { kind: 'rows', rows: value.filter(record).map(rowOf) };
  if (record(value)) return { kind: 'facts', facts: factsOf(value) };
  return { kind: 'rows', rows: [] };
}

function rowOf(row: Record<string, unknown>, index: number): ResourceRow {
  const title =
    text(row.display_name) ?? text(row.title) ?? text(row.name) ?? text(row.email) ?? text(row.content) ?? '—';
  const subtitle = [row.description, row.summary, row.address, row.content]
    .map(text)
    .find((v) => v && v !== title);
  return {
    id: String(row.id ?? row.name ?? index),
    title,
    subtitle,
    status: text(row.status),
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string').slice(0, 4) : [],
    time: text(row.updated_at) ?? text(row.created_at),
  };
}

/** `minutes_this_month` → `Minutes this month`. */
export function humanizeKey(key: string): string {
  const words = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A row's status in words: the surface's own words for it, nothing for its usual state (`null`), or
 * the humanized value rather than a raw field value.
 */
export function statusWords<K extends string>(
  status: string | undefined,
  words: Readonly<Record<string, K | null>> | undefined,
  say: (key: K) => string,
): string | undefined {
  if (!status) return undefined;
  if (words && Object.prototype.hasOwnProperty.call(words, status)) {
    const key = words[status];
    return key ? say(key) : undefined;
  }
  return humanizeKey(status);
}

function factsOf(value: Record<string, unknown>): ResourceFact[] {
  return Object.entries(value)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([key, v]) => ({ key, label: humanizeKey(key), value: v as ResourceFact['value'] }));
}
