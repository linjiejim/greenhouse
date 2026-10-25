/**
 * A reply's tool steps in people's words (React-free, ./tool-words.test.ts):
 *
 *  - `toolActivity` — the one-line status beside the author while a reply works
 *    ("Searching knowledge…", or "3 steps" once nothing runs);
 *  - `toolName` — what a tool is called in the steps sheet ("Knowledge");
 *  - `toolArgs` — what was asked, as label/value pairs (never raw JSON);
 *  - `toolResult` — what came back, as one short line (the raw value stays behind a toggle);
 *  - `toolSummary` — the one line a collapsed step shows beside its name: a failure's error, else
 *    the argument that matters most (the query, the title), else what came back.
 *
 * Known tools have their own words in the catalogs (`tools.name.<id>`, `tools.doing.<id>`);
 * anything else reads as its humanized id.
 */

import type { TFunction, TranslationKey } from '../lib/i18n';
import type { ToolStep } from './parts';

/** Tools with their own words in en.ts / zh.ts (`tools.name.*`, `tools.doing.*`). */
export const KNOWN_TOOLS = [
  'knowledge_query',
  'knowledge_mutation',
  'web_search',
  'external_search',
  'read_url',
  'project_query',
  'project_mutation',
  'tables_query',
  'tables_mutation',
  'tables_schema_plan',
  'files_query',
  'files_mutation',
  'session_query',
  'email_query',
  'email_mutation',
  'memory',
  'read_attachment',
  'analyze_image',
  'generate_image',
  'compute',
  'export_data',
  'ask_user',
  'task_capture',
  'automation_query',
  'automation_mutation',
  'report_render',
  'mcp_call',
] as const;

/** Argument names with their own label (`tools.arg.*`). */
export const KNOWN_ARGS = [
  'query',
  'action',
  'title',
  'url',
  'limit',
  'path',
  'name',
  'prompt',
  'status',
  'scope',
  'visibility',
  'content',
] as const;

const known = (tool: string): tool is (typeof KNOWN_TOOLS)[number] => (KNOWN_TOOLS as readonly string[]).includes(tool);

/** `knowledge_query` → "Knowledge query". */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

export function toolName(tool: string, t: TFunction): string {
  return known(tool) ? t(`tools.name.${tool}` as TranslationKey) : humanize(tool);
}

/** The status beside the author: the tool running now, else how many steps the reply took. */
export function toolActivity(steps: readonly ToolStep[], runningTool: string | null, t: TFunction): string | null {
  const running = runningTool ?? [...steps].reverse().find((step) => step.status === 'running')?.tool ?? null;
  if (running)
    return known(running)
      ? t(`tools.doing.${running}` as TranslationKey)
      : t('tools.using', { tool: humanize(running) });
  if (!steps.length) return null;
  return steps.length === 1 ? t('tools.step1') : t('tools.steps', { n: steps.length });
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const MAX_VALUE = 160;

/** A value in words: text as is (cut), numbers and yes/no, short lists joined; objects are skipped. */
function words(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (Array.isArray(value)) {
    const items = value.map(words).filter((item): item is string => !!item);
    if (!items.length) return null;
    const joined = items.slice(0, 5).join(', ');
    return items.length > 5 ? `${joined} …` : joined;
  }
  return null;
}

/** What was asked, as label/value pairs. A string input is the query itself. */
export function toolArgs(input: unknown, t: TFunction): { label: string; value: string }[] {
  if (typeof input === 'string' && !record(input)) {
    const value = words(input);
    return value ? [{ label: t('tools.arg.query'), value }] : [];
  }
  const args = record(input);
  if (!args) return [];
  return Object.entries(args).flatMap(([key, raw]) => {
    const value = words(raw);
    if (!value) return [];
    const label = (KNOWN_ARGS as readonly string[]).includes(key)
      ? t(`tools.arg.${key}` as TranslationKey)
      : humanize(key);
    return [{ label, value }];
  });
}

const LIST_KEYS = [
  'results',
  'items',
  'docs',
  'documents',
  'rows',
  'records',
  'files',
  'projects',
  'tasks',
  'sessions',
  'matches',
  'hits',
];
const COUNT_KEYS = ['total', 'count', 'found', 'resultCount'];
const TEXT_KEYS = ['summary', 'message', 'answer', 'title', 'name', 'filename'];

function itemTitle(item: unknown): string | null {
  const entry = record(item);
  if (!entry) return typeof item === 'string' ? item : null;
  const title = [entry.title, entry.name, entry.filename, entry.url].find(
    (value) => typeof value === 'string' && value.trim(),
  );
  return typeof title === 'string' ? title : null;
}

/** What came back, in one line: the error, how many results (and the first titles), or its message. */
export function toolResult(step: ToolStep, t: TFunction): string {
  if (step.status === 'running') return t('tools.running');
  const output = record(step.output);
  if (!output) {
    const text = words(step.output);
    return text ?? (step.status === 'failed' ? t('tools.failed') : t('tools.finished'));
  }
  if (typeof output.error === 'string' && output.error && !output.success) return output.error;
  if (step.status === 'failed') return t('tools.failed');
  for (const key of LIST_KEYS) {
    const list = output[key];
    if (!Array.isArray(list)) continue;
    const titles = list
      .map(itemTitle)
      .filter((title): title is string => !!title)
      .slice(0, 3);
    const total =
      COUNT_KEYS.map((name) => output[name]).find((value): value is number => typeof value === 'number') ?? list.length;
    const head = t('tools.results', { n: total });
    return titles.length ? `${head}: ${titles.join(', ')}${total > titles.length ? '…' : ''}` : head;
  }
  // a bare count, under a counting name or a list's name (`{ docs: 10 }`)
  const count = [...COUNT_KEYS, ...LIST_KEYS]
    .map((name) => output[name])
    .find((value): value is number => typeof value === 'number');
  if (count !== undefined) return t('tools.results', { n: count });
  for (const key of TEXT_KEYS) {
    const text = words(output[key]);
    if (text) return text;
  }
  return t('tools.finished');
}

/** The raw value for the "show raw" toggle (pretty JSON, cut). */
export function rawValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, 8000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 8000);
  } catch {
    return String(value);
  }
}

/** Arguments that say what a step was about, the most telling first. */
const KEY_ARGS = ['query', 'q', 'title', 'name', 'filename', 'url', 'path', 'question', 'prompt'];
const MAX_SUMMARY = 80;

function oneLine(text: string | null): string | null {
  const line = text?.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY)}…` : line;
}

/** A collapsed step's one line beside its name; null when there is nothing worth saying. */
export function toolSummary(step: ToolStep, t: TFunction): string | null {
  if (step.status === 'failed') return oneLine(toolResult(step, t));
  const args = record(step.input);
  if (!args && typeof step.input === 'string') return oneLine(step.input);
  for (const key of KEY_ARGS) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  if (step.status === 'running') return null;
  const result = toolResult(step, t);
  return result === t('tools.finished') ? null : oneLine(result);
}
