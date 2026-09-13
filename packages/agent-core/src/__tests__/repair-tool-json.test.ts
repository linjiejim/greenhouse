/**
 * Tool-argument repair — what stands between a mistyped brace and a lost call.
 *
 * Each case here is a way a model actually broke a long payload on dev; the
 * `workflow_plan` one is the shape that made a user's workflow fail three times
 * in a row until they gave up on it.
 */

import { describe, it, expect } from 'vitest';
import { repairJsonArguments } from '../repair-tool-json.js';

describe('repairJsonArguments', () => {
  it('returns valid JSON untouched', () => {
    const raw = '{"action":"draft","count":3}';
    expect(repairJsonArguments(raw)).toBe(raw);
  });

  it('escapes an unescaped quote inside a value', () => {
    const raw = '{"objective":"调研 Click and Grow（官网 "clickandgrow.com"）的在售型号"}';
    const fixed = repairJsonArguments(raw);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({
      objective: '调研 Click and Grow（官网 "clickandgrow.com"）的在售型号',
    });
  });

  it('escapes raw newlines and tabs inside a value', () => {
    const raw = '{"brief":"第一行\n\t第二行"}';
    const fixed = repairJsonArguments(raw);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ brief: '第一行\n\t第二行' });
  });

  it('drops trailing commas', () => {
    const fixed = repairJsonArguments('{"a":1,"b":[1,2,],}');
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ a: 1, b: [1, 2] });
  });

  it('closes output that was cut off mid-string', () => {
    const fixed = repairJsonArguments('{"nodes":[{"id":"research","brief":"调研 Click and Grow 的');
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({
      nodes: [{ id: 'research', brief: '调研 Click and Grow 的' }],
    });
  });

  it('repairs a nested workflow graph carrying prose with quotes', () => {
    const raw =
      '{"name":"竞品调研","graph":{"nodes":[{"id":"research_clickgrow","agent":"team","brief":{"objective":"收集 "Smart Garden 9" 的规格与价格","inputs":{"task":"$run.input"}}}],"deliverable_node":"synthesis"}}';
    const fixed = repairJsonArguments(raw);
    expect(fixed).not.toBeNull();
    const parsed = JSON.parse(fixed!);
    expect(parsed.graph.nodes[0].brief.objective).toBe('收集 "Smart Garden 9" 的规格与价格');
    expect(parsed.graph.nodes[0].brief.inputs.task).toBe('$run.input');
    expect(parsed.graph.deliverable_node).toBe('synthesis');
  });

  it('preserves already-escaped sequences rather than double-escaping them', () => {
    const raw = '{"a":"already \\"quoted\\" and \\\\ backslashed","b":2,}';
    const fixed = repairJsonArguments(raw);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ a: 'already "quoted" and \\ backslashed', b: 2 });
  });

  it('salvages a value whose unescaped quote is followed by ", " mid-sentence', () => {
    // dev friction 59: a 4-item `tables_mutation` batch died twice on
    // `Expected double-quoted property name` because the loose pass ended the
    // string at `很好", ` and left the prose after it where a key must be.
    const raw =
      '{"action":"records.batch_upsert","table_id":2,"items":[{"values":{"2":"标题A","5":"他说"很好", 然后就走了"}},{"values":{"2":"标题B","5":"普通理由"}}]}';
    const fixed = repairJsonArguments(raw);
    expect(fixed).not.toBeNull();
    const parsed = JSON.parse(fixed!);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].values['5']).toBe('他说"很好", 然后就走了');
    expect(parsed.items[1].values['2']).toBe('标题B');
  });

  it('still ends the string at a real element boundary', () => {
    // The same `", ` shape, but a genuine boundary — the strict pass must not
    // swallow the rest of the array into one value.
    const raw = '{"tags":["他说"好", "第二项"],"n":1}';
    const fixed = repairJsonArguments(raw);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ tags: ['他说"好', '第二项'], n: 1 });
  });

  it('gives up rather than inventing structure', () => {
    expect(repairJsonArguments('')).toBeNull();
    expect(repairJsonArguments('   ')).toBeNull();
    expect(repairJsonArguments('this is not json at all')).toBeNull();
  });
});
