import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SchemaPlanAccessChange, SchemaPlanOperation } from '@greenhouse/types/tables';
import { I18nProvider } from '../../lib/i18n';
import { SchemaPlanCard } from './schema-plan-card';
import { isArtifactCall } from '../tool-call/body-artifacts';

const OPERATIONS: SchemaPlanOperation[] = [
  { op: 'base.create', ref: 'b', name: 'Customer follow-up', defaultTableRef: 'leads', defaultTableName: 'Leads' },
  { op: 'field.create', tableRef: 'leads', name: 'Company', type: 'text', required: true },
  { op: 'field.create', tableRef: 'leads', name: 'Stage', type: 'single_select' },
  { op: 'field.archive', tableId: 4, fieldId: 9 },
];

const BUILD_OPERATIONS: SchemaPlanOperation[] = [
  { op: 'field.create', ref: 'stage', tableId: 4, name: 'Stage', type: 'single_select' },
  {
    op: 'view.create',
    tableId: 4,
    name: 'Pipeline',
    type: 'kanban',
    config: { kanban: { groupFieldId: '$field:stage' } },
  },
  { op: 'form.create', tableId: 4, name: 'New lead', status: 'published', audience: { type: 'team' }, config: {} },
  { op: 'automation.create', tableId: 4, name: 'Deal won', trigger: 'record_updated', config: {} },
  { op: 'dashboard.create', ref: 'd', baseId: 1, name: 'Overview' },
  { op: 'widget.create', dashboardRef: 'd', title: 'Won this month', card: { kind: 'kpi' } },
  { op: 'role.create', ref: 'r', baseId: 1, name: 'Sales rep', rules: {} },
  { op: 'member.set', baseId: 1, principal: 'group', groupId: 7, role: 'custom', roleRef: 'r' },
];

const ACCESS_CHANGES: SchemaPlanAccessChange[] = [
  { index: 2, kind: 'form', form: 'New lead', before: null, after: { kind: 'team' }, published: true },
  {
    index: 6,
    kind: 'role',
    role: 'Sales rep',
    before: null,
    after: { dashboards: true, tables: [{ table: 'Deals', access: 'edit', limitedRows: true, hiddenFields: 1 }] },
  },
  {
    index: 7,
    kind: 'grant',
    base: 'CRM',
    principal: 'group',
    name: 'Sales',
    before: { kind: 'role', role: 'viewer' },
    after: { kind: 'custom', roleName: 'Sales rep' },
  },
];

function render(
  locale: 'en' | 'zh',
  operations: SchemaPlanOperation[] = OPERATIONS,
  accessChanges?: SchemaPlanAccessChange[],
  targetNames?: Record<number, string>,
) {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: locale,
      children: createElement(SchemaPlanCard, {
        artifact: {
          type: 'tables_schema_plan',
          summary: 'Add a follow-up Base',
          operations,
          ...(accessChanges ? { accessChanges } : {}),
          ...(targetNames ? { targetNames } : {}),
        },
      }),
    }),
  );
}

describe('SchemaPlanCard', () => {
  it('lists what will change and says nothing has happened yet', () => {
    const html = render('en');

    expect(html).toContain('Table structure change');
    expect(html).toContain('Add a follow-up Base');
    expect(html).toContain('4 changes');
    // Every operation is legible before confirming — this card is the only
    // place the user gets to see what they are agreeing to.
    expect(html).toContain('Create Base');
    expect(html).toContain('Customer follow-up');
    expect(html).toContain('Add field');
    expect(html).toContain('Company');
    // Types in words, never the stored code.
    expect(html).toContain('Single select');
    expect(html).not.toContain('single_select');
    expect(html).toContain('Archive field');
    expect(html).toContain('Nothing has been created yet');
    expect(html).toContain('Confirm');
  });

  it('resolves its Chinese copy (every key exists in both locales)', () => {
    const html = render('zh');

    expect(html).toContain('表结构变更');
    expect(html).toContain('4 项变更');
    expect(html).toContain('新建 Base');
    expect(html).toContain('尚未创建任何内容');
    // A missing key would render the raw dotted path instead of prose.
    expect(html).not.toContain('tablesSchemaPlan.');
  });

  it('groups operations by kind and puts permission changes first, before Confirm', () => {
    const html = render('en', BUILD_OPERATIONS, ACCESS_CHANGES);

    for (const heading of ['Fields', 'Views', 'Forms', 'Automations', 'Dashboards', 'Roles and members']) {
      expect(html).toContain(heading);
    }
    for (const label of [
      'Create view',
      'Create form',
      'Create automation',
      'Create dashboard',
      'Add widget',
      'Create role',
      'Set member access',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Kanban');
    expect(html).toContain('A record is updated');
    expect(html).toContain('KPI');
    expect(html).not.toContain('record_updated');

    // The access section is server-derived, before → after, and sits above every operation and the Confirm button.
    const section = html.indexOf('Permission and outbound changes');
    expect(section).toBeGreaterThan(-1);
    expect(section).toBeLessThan(html.indexOf('Add field'));
    expect(section).toBeLessThan(html.indexOf('>Confirm<'));
    expect(html).toContain('Form New lead');
    expect(html).toContain('new form');
    expect(html).toContain('everyone in the team · open for submissions');
    expect(html).toContain('Role Sales rep');
    expect(html).toContain('Deals: edit, limited rows, 1 hidden field; dashboards');
    expect(html).toContain('Group Sales on CRM');
    expect(html).toContain('viewer');
    expect(html).toContain('custom role Sales rep');
  });

  it('names what a destructive or access operation targets, not just its id', () => {
    const operations: SchemaPlanOperation[] = [
      { op: 'field.archive', tableId: 4, fieldId: 9 },
      { op: 'widget.delete', dashboardId: 3, widgetId: 17 },
      { op: 'member.set', baseId: 1, principal: 'user', userId: '4f2c-user', role: 'editor' },
    ];
    const named = render('en', operations, undefined, { 0: 'Notes', 1: 'Won this month', 2: 'Mia' });
    expect(named).toContain('Notes');
    expect(named).toContain('Won this month');
    expect(named).toContain('Mia');
    expect(named).not.toContain('#17');
    expect(named).not.toContain('4f2c-user');
    // A plan drafted before the server named targets still renders the ids.
    expect(render('en', operations)).toContain('#17');
  });

  it('shows no permission section when the plan changes nobody’s access', () => {
    expect(render('en')).not.toContain('Permission and outbound changes');
  });

  it('words permission changes in Chinese too', () => {
    const html = render('zh', BUILD_OPERATIONS, ACCESS_CHANGES);
    expect(html).toContain('权限与外发变更');
    expect(html).toContain('群组 Sales（CRM）');
    expect(html).toContain('自定义角色 Sales rep');
    expect(html).toContain('角色与成员');
    expect(html).not.toContain('tablesSchemaPlan.');
  });

  it('lists app operations and puts who gets the app, and what goes live, before Confirm', () => {
    const operations: SchemaPlanOperation[] = [
      {
        op: 'app.create',
        ref: 'a',
        baseId: 1,
        name: 'Purchase requests',
        spec: { version: 1, pages: [{}, {}, {}], roles: [{}, {}] },
      },
      {
        op: 'app.audience',
        appRef: 'a',
        entries: [
          { principal: { type: 'team' }, roleKey: 'applicant' },
          { principal: { type: 'group', groupId: 7 }, roleKey: 'approver' },
        ],
      },
      { op: 'app.publish', appRef: 'a', notes: 'v1' },
    ];
    const changes: SchemaPlanAccessChange[] = [
      {
        index: 1,
        kind: 'app_audience',
        app: 'Purchase requests',
        before: null,
        after: [
          { principal: 'team', name: '', role: 'Applicant' },
          { principal: 'group', name: 'Finance', role: 'Approver', managedBy: 'Ann' },
        ],
      },
      {
        index: 2,
        kind: 'app_publish',
        app: 'Purchase requests',
        version: 1,
        audience: [{ principal: 'team', name: '', role: 'Applicant' }],
      },
    ];
    const html = render('en', operations, changes, { 1: 'Purchase requests', 2: 'Purchase requests' });
    expect(html).toContain('Apps');
    expect(html).toContain('Create app');
    expect(html).toContain('3 pages · 2 roles');
    expect(html).toContain('Share app');
    expect(html).toContain('Publish app');
    expect(html).toContain('Who uses the app Purchase requests');
    expect(html).toContain('shared with nobody');
    expect(html).toContain('everyone in the team as Applicant; group Finance (managed by Ann) as Approver');
    expect(html).toContain('Publish the app Purchase requests');
    expect(html).toContain('v1 live for everyone in the team as Applicant');
    expect(html.indexOf('Who uses the app')).toBeLessThan(html.indexOf('Create app'));

    const zh = render('zh', operations, changes);
    expect(zh).toContain('新建应用');
    expect(zh).toContain('群组 Finance（由 Ann 管理）为「Approver」');
    expect(zh).not.toContain('apps.agent.');
  });

  it('is registered as a body artifact only for a validated plan', () => {
    expect(isArtifactCall({ name: 'tables_schema_plan', output: { type: 'tables_schema_plan' } })).toBe(true);
    // A refusal stays a readable trace row rather than becoming a broken card.
    expect(isArtifactCall({ name: 'tables_schema_plan', output: { error: 'needs the builder role' } })).toBe(false);
  });
});
