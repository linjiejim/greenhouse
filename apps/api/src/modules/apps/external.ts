import type { AppCard } from '@greenhouse/contract';
import type { AppCardAnswer } from '@greenhouse/contract/client';
import { invalidInput } from '../../http/errors.js';

/** RFC 6901, own properties only; no expressions or prototype traversal. */
export function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw invalidInput('Use a JSON Pointer for external data.');
  let result = value;
  for (const part of path
    .slice(1)
    .split('/')
    .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, part)) return null;
    result = (result as Record<string, unknown>)[part];
  }
  return result;
}
const scalar = (v: unknown): string | number | boolean | null =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
    ? v
    : null;
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function mapExternal(card: Extract<AppCard, { kind: 'external' }>, data: unknown): AppCardAnswer {
  const map = card.map;
  if (map.kind === 'number')
    return { kind: 'chart', data: { kind: 'number', value: number(pointer(data, map.value)), records: 0 } };
  const source = pointer(data, map.rows);
  if (!Array.isArray(source)) throw invalidInput('The external data path must name an array.');
  const rows = source.slice(0, 100);
  if (map.kind === 'table')
    return {
      kind: 'external',
      columns: map.columns.map((c) => c.label),
      rows: rows.map((row) => map.columns.map((c) => scalar(pointer(row, c.path)))),
    };
  return {
    kind: 'chart',
    data: {
      kind: 'groups',
      key_type: 'text',
      records: rows.length,
      other: null,
      groups: rows.map((row, index) => ({
        key: String(index),
        label: String(scalar(pointer(row, map.group)) ?? ''),
        value: number(pointer(row, map.value)),
        records: 1,
      })),
    },
  };
}
