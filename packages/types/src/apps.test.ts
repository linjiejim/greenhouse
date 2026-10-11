import { describe, expect, it } from 'vitest';
import { actionAllowedForRole, appSpecDependencies, pagesForRole, type AppSpec } from './apps.js';

const spec: AppSpec = {
  version: 1,
  roles: [
    {
      key: 'applicant',
      name: 'Applicant',
      pages: ['mine'],
      tables: [
        {
          tableId: 1,
          access: 'edit',
          rows: { type: 'related', creator: true, fieldIds: [] },
          fields: [{ fieldId: 13, access: 'hidden' }],
          fieldDefault: 'visible',
        },
      ],
    },
    { key: 'approver', name: 'Approver', pages: 'all', tables: [] },
  ],
  pages: [
    {
      id: 'mine',
      title: 'My requests',
      cards: [
        {
          id: 'list',
          kind: 'records',
          layout: { x: 0, y: 0, w: 12, h: 6 },
          source: {
            tableId: 1,
            query: {
              where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
            },
          },
          fieldIds: [10, 11],
        },
      ],
    },
    {
      id: 'review',
      title: 'Review',
      filters: [{ id: 'when', label: 'When', kind: 'date_range', targets: [{ tableId: 1, fieldId: 12 }] }],
      cards: [
        {
          id: 'board',
          kind: 'kanban',
          layout: { x: 0, y: 0, w: 12, h: 8 },
          source: { tableId: 1 },
          groupFieldId: 14,
          fieldIds: [10],
          actions: [
            {
              id: 'approve',
              label: 'Approve',
              roles: ['approver'],
              when: { combinator: 'and', clauses: [{ fieldId: 14, operator: 'eq', value: 'pending' }] },
              do: { type: 'set_fields', values: [{ fieldId: 14, value: 'approved' }], inputFieldIds: [15] },
            },
            { id: 'notify', label: 'Notify', do: { type: 'run_automation', ruleId: 3 } },
          ],
        },
        {
          id: 'total',
          kind: 'kpi',
          layout: { x: 0, y: 8, w: 4, h: 3 },
          card: { kind: 'kpi', source: { tableId: 2 }, aggregate: { operation: 'sum', valueFieldId: 20 } },
        },
      ],
    },
  ],
};

describe('apps spec helpers', () => {
  it('limits pages by role', () => {
    expect(pagesForRole(spec, spec.roles[0]!).map((page) => page.id)).toEqual(['mine']);
    expect(pagesForRole(spec, spec.roles[1]!).map((page) => page.id)).toEqual(['mine', 'review']);
  });

  it('allows an action only to listed roles that can see the page', () => {
    const approve = spec.pages[1]!.cards[0]!;
    if (approve.kind !== 'kanban') throw new Error('fixture');
    const action = approve.actions![0]!;
    expect(actionAllowedForRole(spec, 'review', action, 'approver')).toBe(true);
    expect(actionAllowedForRole(spec, 'review', action, 'applicant')).toBe(false);
    expect(actionAllowedForRole(spec, 'review', approve.actions![1]!, 'applicant')).toBe(false);
    expect(actionAllowedForRole(spec, 'review', approve.actions![1]!, 'approver')).toBe(true);
  });

  it('collects every table, field, rule and role the spec depends on', () => {
    expect(appSpecDependencies(spec)).toEqual({
      tableIds: [1, 2],
      fieldIds: [10, 11, 12, 13, 14, 15, 20],
      ruleIds: [3],
      roleKeys: ['applicant', 'approver'],
    });
  });
});
