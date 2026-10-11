/**
 * What the publish dialog says publishing changes: structure (pages, cards,
 * roles) against the live version, every permission that moves before →
 * after, and which audience entries lose or gain access.
 */

import { describe, expect, it } from 'vitest';
import type { AppAudienceEntryView, AppCard, AppSpec } from '@greenhouse/types/apps';
import { audienceImpact, diffSpecs, isEmptyDiff, stableJson } from './spec-diff';
import { FIELDS, REQUESTS, schemaFixture, specFixture } from './test-fixtures';

const fieldIds = (tableId: number) => (schemaFixture().fieldsByTable.get(tableId) ?? []).map((field) => field.id);

describe('stableJson', () => {
  it('compares by value whatever the key order', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      stableJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
});

describe('diffSpecs', () => {
  it('calls the first publish a first version, with every role and grant new', () => {
    const diff = diffSpecs(null, specFixture(), fieldIds);
    expect(diff.first).toBe(true);
    expect(diff.pagesAdded.map((page) => page.id)).toEqual(['apply', 'approve']);
    expect(diff.permissions.filter((change) => change.kind === 'roleAdded').map((change) => change.roleKey)).toEqual([
      'applicant',
      'approver',
    ]);
    expect(diff.permissions).toContainEqual({
      kind: 'table',
      roleKey: 'approver',
      roleName: 'Approver',
      tableId: REQUESTS,
      before: 'none',
      after: 'edit',
      visibleAfter: fieldIds(REQUESTS).length,
      editableAfter: fieldIds(REQUESTS).length,
    });
  });

  it('finds nothing when only the key order differs', () => {
    const live = specFixture();
    const draft = JSON.parse(stableJson(live)) as AppSpec;
    const diff = diffSpecs(live, draft, fieldIds);
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.permissions).toEqual([]);
  });

  it('lists pages, cards and roles added, removed and changed', () => {
    const live = specFixture();
    const draft = specFixture();
    draft.pages[0]!.title = 'Request';
    (draft.pages[0]!.cards[0] as Extract<AppCard, { kind: 'records' }>).fieldIds = [1];
    draft.pages[0]!.cards.push({ id: 'note', kind: 'text', layout: { x: 0, y: 6, w: 12, h: 2 }, markdown: '' });
    draft.pages.splice(1, 1);
    draft.pages.push({
      id: 'stats',
      title: 'Stats',
      cards: [{ id: 't', kind: 'text', layout: { x: 0, y: 0, w: 12, h: 2 }, markdown: '' }],
    });
    draft.roles[1] = { ...draft.roles[1]!, pages: ['apply', 'stats'] };
    draft.roles.push({ key: 'auditor', name: 'Auditor', pages: 'all', tables: [] });
    const diff = diffSpecs(live, draft, fieldIds);
    expect(diff.first).toBe(false);
    expect(diff.pagesAdded.map((page) => page.id)).toEqual(['stats']);
    expect(diff.pagesRemoved.map((page) => page.id)).toEqual(['approve']);
    expect(diff.pagesChanged).toHaveLength(1);
    expect(diff.pagesChanged[0]).toMatchObject({ renamedFrom: 'Apply', settingsChanged: false });
    expect(diff.pagesChanged[0]!.cardsAdded.map((card) => card.id)).toEqual(['note']);
    expect(diff.pagesChanged[0]!.cardsChanged.map((card) => card.id)).toEqual(['mine']);
    expect(diff.rolesAdded.map((role) => role.key)).toEqual(['auditor']);
    expect(diff.rolesChanged.map((role) => role.key)).toEqual(['approver']);
    expect(diff.permissions).toContainEqual({
      kind: 'pages',
      roleKey: 'approver',
      roleName: 'Approver',
      before: 'all',
      after: ['apply', 'stats'],
    });
  });

  it('reports each permission before → after: access, rows, create / delete, fields, comments, removed roles', () => {
    const live = specFixture();
    const draft = specFixture();
    draft.roles[0] = {
      ...draft.roles[0]!,
      canComment: true,
      tables: [
        {
          tableId: REQUESTS,
          access: 'read',
          rows: { type: 'related', creator: true, fieldIds: [] },
          fields: [{ fieldId: FIELDS.item.id, access: 'read' }],
          fieldDefault: 'hidden',
        },
      ],
    };
    draft.roles[1] = {
      ...draft.roles[1]!,
      tables: [
        {
          tableId: REQUESTS,
          access: 'edit',
          fields: [{ fieldId: FIELDS.reason.id, access: 'hidden' }],
          fieldDefault: 'visible',
          delete: true,
          create: false,
          editRows: {
            type: 'where',
            where: { combinator: 'and', clauses: [{ fieldId: 3, operator: 'eq', value: 'pending' }] },
          },
        },
      ],
    };
    const diff = diffSpecs(live, draft, fieldIds);
    const of = (roleKey: string) => diff.permissions.filter((change) => change.roleKey === roleKey);
    expect(of('applicant')).toEqual([
      { kind: 'comment', roleKey: 'applicant', roleName: 'Applicant', before: false, after: true },
      {
        kind: 'table',
        roleKey: 'applicant',
        roleName: 'Applicant',
        tableId: REQUESTS,
        before: 'none',
        after: 'read',
        visibleAfter: 1,
        editableAfter: 0,
      },
    ]);
    expect(of('approver')).toEqual([
      {
        kind: 'editRows',
        roleKey: 'approver',
        roleName: 'Approver',
        tableId: REQUESTS,
        before: 'all',
        after: 'where',
        changed: false,
      },
      { kind: 'create', roleKey: 'approver', roleName: 'Approver', tableId: REQUESTS, before: true, after: false },
      { kind: 'delete', roleKey: 'approver', roleName: 'Approver', tableId: REQUESTS, before: false, after: true },
      {
        kind: 'field',
        roleKey: 'approver',
        roleName: 'Approver',
        tableId: REQUESTS,
        fieldId: FIELDS.reason.id,
        before: 'edit',
        after: 'hidden',
      },
    ]);

    const dropped = diffSpecs(live, { ...live, roles: [live.roles[1]!] }, fieldIds);
    expect(dropped.permissions).toEqual([{ kind: 'roleRemoved', roleKey: 'applicant', roleName: 'Applicant' }]);
    expect(dropped.rolesRemoved.map((role) => role.key)).toEqual(['applicant']);
  });

  it('says a scope changed when its kind stays but its conditions move', () => {
    const live = specFixture();
    live.roles[0]!.tables = [
      {
        tableId: REQUESTS,
        access: 'read',
        rows: {
          type: 'where',
          where: { combinator: 'and', clauses: [{ fieldId: 3, operator: 'eq', value: 'pending' }] },
        },
        fields: [],
        fieldDefault: 'visible',
      },
    ];
    const draft = JSON.parse(JSON.stringify(live)) as AppSpec;
    draft.roles[0]!.tables[0]!.rows = {
      type: 'where',
      where: { combinator: 'and', clauses: [{ fieldId: 3, operator: 'eq', value: 'approved' }] },
    };
    expect(diffSpecs(live, draft, fieldIds).permissions).toEqual([
      {
        kind: 'rows',
        roleKey: 'applicant',
        roleName: 'Applicant',
        tableId: REQUESTS,
        before: 'where',
        after: 'where',
        changed: true,
      },
    ]);
  });
});

describe('audienceImpact', () => {
  it('flags entries whose role this version drops, and entries this version brings to life', () => {
    const entries: AppAudienceEntryView[] = [
      { principal: { type: 'team' }, roleKey: 'applicant', name: 'everyone' },
      {
        principal: { type: 'group', groupId: 4 },
        roleKey: 'gone',
        name: 'Finance',
        managedBy: { id: 'u9', name: 'Ada' },
      },
      { principal: { type: 'user', userId: 'u2' }, roleKey: 'approver', name: 'Bo', dangling: true },
    ];
    expect(
      audienceImpact(entries, specFixture()).map(({ losesAccess, gainsAccess }) => [losesAccess, gainsAccess]),
    ).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
  });
});
