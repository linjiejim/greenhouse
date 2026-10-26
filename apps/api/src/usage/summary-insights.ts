import type { RetroAggregates } from '../usage/summary.js';
export const FRICTION_ERROR_CLASSES = [
  'not_found',
  'permission',
  'invalid_input',
  'conflict',
  'limit',
  'timeout',
  'empty_result',
  'other',
] as const;
export type FrictionErrorClass = (typeof FRICTION_ERROR_CLASSES)[number];

const ERROR_CLASS_PATTERNS: Array<[FrictionErrorClass, RegExp]> = [
  ['permission', /forbidden|permission|not allowed|denied|unauthori[sz]ed|access|无权|权限|拒绝/i],
  ['not_found', /not found|no such|does not exist|doesn't exist|unknown|missing|找不到|不存在|未找到/i],
  ['limit', /budget|quota|rate.?limit|too many|exceed|额度|限流|超出|超过/i],
  ['timeout', /time(?:d)? ?out|timeout|超时/i],
  ['conflict', /conflict|already exists|duplicate|revision|冲突|已存在|重复/i],
  ['invalid_input', /invalid|required|must be|expected|malformed|schema|parse|format|非法|必填|格式|无效/i],
  ['empty_result', /empty|no results?|nothing found|found: ?0|空|没有结果/i],
];

/**
 * The class of a friction's error, from a closed list. The summary is read
 * here and nowhere else in the retro: only the class leaves this function.
 */
export function frictionErrorClass(summary: string): FrictionErrorClass {
  for (const [errorClass, pattern] of ERROR_CLASS_PATTERNS) if (pattern.test(summary)) return errorClass;
  return 'other';
}
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
export function groupFrictions(
  rows: ReadonlyArray<{ tool_id: string | null; kind: string; summary: string; occurrence_count: number }>,
): RetroAggregates['frictions']['top'] {
  const groups = new Map<string, RetroAggregates['frictions']['top'][number]>();
  for (const row of rows) {
    const errorClass = frictionErrorClass(row.summary);
    const key = `${row.tool_id ?? ''}|${row.kind}|${errorClass}`;
    const entry = groups.get(key) ?? {
      tool: row.tool_id,
      kind: row.kind,
      error_class: errorClass,
      frictions: 0,
      occurrences: 0,
    };
    entry.frictions += 1;
    entry.occurrences += row.occurrence_count;
    groups.set(key, entry);
  }
  return [...groups.values()].sort(
    (a, b) => b.occurrences - a.occurrences || b.frictions - a.frictions || (a.tool ?? '').localeCompare(b.tool ?? ''),
  );
}
