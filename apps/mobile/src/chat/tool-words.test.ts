import { describe, expect, it } from 'vitest';
import type { TFunction } from '../lib/i18n';
import { humanize, toolActivity, toolArgs, toolName, toolResult, toolSummary } from './tool-words';
import type { ToolStep } from './parts';

// the catalog key and its vars, so the test reads which words were picked
const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}${JSON.stringify(vars)}` : key) as TFunction;
const step = (patch: Partial<ToolStep>): ToolStep => ({ id: 'p1', tool: 'knowledge_query', status: 'done', ...patch });

describe('tool steps in words', () => {
  it('names known tools from the catalog and humanizes the rest', () => {
    expect(toolName('knowledge_query', t)).toBe('tools.name.knowledge_query');
    expect(toolName('crm_navigate', t)).toBe('Crm navigate');
    expect(humanize('read-url')).toBe('Read url');
  });

  it('says what runs now, else how many steps the reply took', () => {
    expect(toolActivity([step({ status: 'running' })], null, t)).toBe('tools.doing.knowledge_query');
    expect(toolActivity([], 'crm_navigate', t)).toBe('tools.using{"tool":"Crm navigate"}');
    expect(toolActivity([step({})], null, t)).toBe('tools.step1');
    expect(toolActivity([step({}), step({ id: 'p2' })], null, t)).toBe('tools.steps{"n":2}');
    expect(toolActivity([], null, t)).toBeNull();
  });

  it('turns arguments into labelled words and skips nested objects', () => {
    expect(toolArgs({ query: 'onboarding', limit: 20, filters: { a: 1 }, tags: ['hr', 'eng'], empty: '' }, t)).toEqual([
      { label: 'tools.arg.query', value: 'onboarding' },
      { label: 'tools.arg.limit', value: '20' },
      { label: 'Tags', value: 'hr, eng' },
    ]);
    expect(toolArgs('{"query":"x"}', t)).toEqual([{ label: 'tools.arg.query', value: 'x' }]);
    expect(toolArgs('plain words', t)).toEqual([{ label: 'tools.arg.query', value: 'plain words' }]);
  });

  it('sums up a result in one line', () => {
    expect(toolResult(step({ status: 'running' }), t)).toBe('tools.running');
    expect(toolResult(step({ output: { error: 'no access' }, status: 'failed' }), t)).toBe('no access');
    expect(toolResult(step({ output: { results: [{ title: 'A' }, { title: 'B' }], total: 7 } }), t)).toBe(
      'tools.results{"n":7}: A, B…',
    );
    expect(toolResult(step({ output: { docs: 10, root: '/' } }), t)).toBe('tools.results{"n":10}');
    expect(toolResult(step({ output: { message: 'Saved' } }), t)).toBe('Saved');
    expect(toolResult(step({ output: { ok: true } }), t)).toBe('tools.finished');
  });

  it('sums a collapsed step up in one line: the error, the key argument, else the result', () => {
    expect(toolSummary(step({ status: 'failed', input: { query: 'x' }, output: { error: 'no access' } }), t)).toBe('no access');
    expect(toolSummary(step({ input: { limit: 5, query: 'onboarding  plan\n2026' }, output: { results: [] } }), t)).toBe(
      'onboarding plan 2026',
    );
    expect(toolSummary(step({ tool: 'knowledge_mutation', input: '{"action":"create","title":"Q4 notes"}' }), t)).toBe('Q4 notes');
    expect(toolSummary(step({ status: 'running', input: { query: 'roadmap' } }), t)).toBe('roadmap');
    expect(toolSummary(step({ status: 'running', input: { limit: 3 } }), t)).toBeNull();
    expect(toolSummary(step({ input: {}, output: { message: 'Saved' } }), t)).toBe('Saved');
    expect(toolSummary(step({ input: {}, output: { ok: true } }), t)).toBeNull();
    expect(toolSummary(step({ input: { query: 'a'.repeat(120) } }), t)).toBe(`${'a'.repeat(80)}…`);
  });
});
