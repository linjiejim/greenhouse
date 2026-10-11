import { describe, expect, it } from 'vitest';
import { normalizeTableCardSpec } from '@greenhouse/types/table-cards';
import type { TableCardSpec } from '@greenhouse/types/tables';
import { cardFromDraft, draftFromCard, emptyDraft, refFromKey, refKey } from './widget-draft';

describe('widget draft', () => {
  it('round-trips a stacked monthly chart and keeps query parts the editor does not show', () => {
    const where = { combinator: 'and' as const, clauses: [{ fieldId: 3, operator: 'gt' as const, value: 10 }] };
    const card: TableCardSpec = {
      kind: 'chart',
      source: { tableId: 7, query: { where, sort: [{ fieldId: 3, direction: 'desc' }], search: 'acme' } },
      aggregate: {
        operation: 'sum',
        valueFieldId: 3,
        groupBy: { systemField: 'created_at', dateBucket: 'month' },
        series: { fieldId: 2 },
        sort: 'group_asc',
        limit: 12,
      },
      chart: { type: 'area', stacked: true, showValues: true },
    };
    const draft = draftFromCard(card, 'Revenue', '');
    expect(draft).toMatchObject({ title: 'Revenue', groupBy: 's:created_at', dateBucket: 'month', series: 'f:2' });
    expect(cardFromDraft(draft, where)).toEqual(card);
  });

  it('drops settings the kind does not use and pie series', () => {
    const draft = {
      ...emptyDraft(7),
      kind: 'chart' as const,
      chartType: 'pie' as const,
      groupBy: 'f:2',
      series: 'f:5',
    };
    const card = cardFromDraft(draft, undefined);
    expect(card.aggregate).toEqual({ operation: 'count', groupBy: { fieldId: 2 } });
    expect(normalizeTableCardSpec(card).ok).toBe(true);
    const kpi = cardFromDraft({ ...draft, kind: 'kpi', operation: 'count', valueFieldId: 3 }, undefined);
    expect(kpi).toEqual({ kind: 'kpi', source: { tableId: 7 }, aggregate: { operation: 'count' } });
    expect(cardFromDraft({ ...draft, kind: 'text', markdown: '# Hi' }, undefined)).toEqual({
      kind: 'text',
      markdown: '# Hi',
    });
  });

  it('encodes field and system refs as select keys', () => {
    expect(refKey({ fieldId: 4 })).toBe('f:4');
    expect(refKey({ systemField: 'created_by' })).toBe('s:created_by');
    expect(refFromKey('f:4')).toEqual({ fieldId: 4 });
    expect(refFromKey('s:created_by')).toEqual({ systemField: 'created_by' });
    expect(refFromKey('s:nope')).toBeUndefined();
    expect(refFromKey('')).toBeUndefined();
  });
});
