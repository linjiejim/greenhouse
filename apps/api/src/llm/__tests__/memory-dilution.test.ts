/**
 * The weekly consolidation lets a model rewrite user facts. These pin the
 * deterministic guard on its merges (spec 20261009 D7): a merge that drops a
 * negation/limit or a number its sources stated is refused, whatever the
 * model says — the memory would otherwise say something else forever.
 */

import { describe, expect, it } from 'vitest';
import { mergeDilutes, parseConsolidationOps } from '../memory.js';

describe('mergeDilutes', () => {
  it('accepts a merge that keeps every negation and number', () => {
    expect(
      mergeDilutes(
        ['Never send reports on Friday', 'No reports on Friday; Monday 09:00 instead'],
        'Never send reports on Friday — send them Monday 09:00',
      ),
    ).toBeNull();
  });

  it('refuses one that drops the negation (the meaning flips)', () => {
    expect(mergeDilutes(['Never send reports on Friday'], 'Send weekly reports')).toBe('drops a negation or limit');
    expect(mergeDilutes(['表格不超过五列'], '偏好用表格')).toBe('drops a negation or limit');
  });

  it('refuses one that drops a number a source stated', () => {
    expect(mergeDilutes(['Budget is 1.2M for Q4', 'Q4 budget approved'], 'The Q4 budget was approved')).toBe(
      'drops "1.2"',
    );
  });
});

describe('parseConsolidationOps', () => {
  const ids = new Set([1, 2, 3]);
  const sources = new Map([
    [1, 'Prefers short answers\nKeep answers under 5 sentences'],
    [2, 'Short answers\nNo long preambles; under 5 sentences'],
    [3, 'Timezone\nUTC+8'],
  ]);

  it('keeps a faithful merge and drops a diluting one', () => {
    const raw = JSON.stringify([
      {
        op: 'merge',
        ids: [1, 2],
        title: 'Prefers short answers',
        content: 'Keep answers under 5 sentences, with no long preambles',
        category: 'preference',
      },
      { op: 'merge', ids: [1, 2], title: 'Prefers short answers', content: 'Be brief', category: 'preference' },
    ]);
    const ops = parseConsolidationOps(raw, ids, sources);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.content).toContain('under 5 sentences');
  });

  it('leaves supersede and demote alone (they rewrite nothing)', () => {
    const raw = JSON.stringify([
      { op: 'supersede', old_id: 1, new_id: 2 },
      { op: 'demote', id: 3 },
    ]);
    expect(parseConsolidationOps(raw, ids, sources).map((op) => op.op)).toEqual(['supersede', 'demote']);
  });
});
