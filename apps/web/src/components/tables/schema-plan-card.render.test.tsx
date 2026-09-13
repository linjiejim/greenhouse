import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';
import { I18nProvider } from '../../lib/i18n';
import { SchemaPlanCard } from './schema-plan-card';
import { isArtifactCall } from '../tool-call/body-artifacts';

const OPERATIONS: SchemaPlanOperation[] = [
  { op: 'base.create', ref: 'b', name: 'Customer follow-up', defaultTableRef: 'leads', defaultTableName: 'Leads' },
  { op: 'field.create', tableRef: 'leads', name: 'Company', type: 'text', required: true },
  { op: 'field.create', tableRef: 'leads', name: 'Stage', type: 'single_select' },
  { op: 'field.archive', tableId: 4, fieldId: 9 },
];

function render(locale: 'en' | 'zh') {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: locale,
      children: createElement(SchemaPlanCard, {
        artifact: { type: 'tables_schema_plan', summary: 'Add a follow-up Base', operations: OPERATIONS },
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
    expect(html).toContain('single_select');
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

  it('is registered as a body artifact only for a validated plan', () => {
    expect(isArtifactCall({ name: 'tables_schema_plan', output: { type: 'tables_schema_plan' } })).toBe(true);
    // A refusal stays a readable trace row rather than becoming a broken card.
    expect(isArtifactCall({ name: 'tables_schema_plan', output: { error: 'needs the builder role' } })).toBe(false);
  });
});
