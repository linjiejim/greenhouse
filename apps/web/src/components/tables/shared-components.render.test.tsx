import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, type Locale } from '../../lib/i18n';
import type { TableField } from '../../lib/api/tables';
import { FieldValue } from './field-value';
import { FilterEditor } from './filter-editor';
import { FieldEditor } from './field-editor';

function field(id: number, type: TableField['type'], config: object = {}): TableField {
  return {
    id,
    table_id: 1,
    name: `Field ${id}`,
    type,
    required: false,
    is_primary: false,
    config: JSON.stringify(config),
    position: id,
    created_by: 'u1',
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    archived_at: null,
  };
}

function render(element: ReactElement, locale: Locale = 'en'): string {
  return renderToStaticMarkup(<I18nProvider initialLocale={locale}>{element}</I18nProvider>);
}

const users = [{ id: 'u1', nickname: 'Jim', email: 'jim@example.com' }];
const usersById = new Map(users.map((user) => [user.id, user]));

describe('FieldValue', () => {
  it('localizes checkbox values instead of printing English', () => {
    expect(render(<FieldValue field={field(1, 'boolean')} value={true} usersById={usersById} />)).toBe('Yes');
    expect(render(<FieldValue field={field(1, 'boolean')} value={false} usersById={usersById} />, 'zh')).toBe('否');
  });

  it('renders a lookup array as read-only chips and an empty one as a dash', () => {
    const lookup = field(2, 'lookup', { lookup: { relationFieldId: 3, targetFieldId: 4 } });
    const html = render(<FieldValue field={lookup} value={['Acme', 'Globex']} usersById={usersById} />);
    expect(html).toContain('Acme');
    expect(html).toContain('Globex');
    expect(render(<FieldValue field={lookup} value={[]} usersById={usersById} />)).toContain('—');
  });

  it('formats a formula by its result type', () => {
    const formula = field(3, 'formula', {
      formula: { resultType: 'boolean', expression: { type: 'literal', value: true } },
    });
    expect(render(<FieldValue field={formula} value={true} usersById={usersById} />)).toBe('Yes');
  });
});

describe('FilterEditor', () => {
  it('offers system columns and the $me token as ordinary choices', () => {
    const html = render(
      <FilterEditor
        value={{ combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] }}
        onChange={vi.fn()}
        fields={[field(1, 'text')]}
        users={users}
      />,
    );
    expect(html).toContain('label="Record info"');
    expect(html).toContain('Created by');
    expect(html).toMatch(/<option value="\$me" selected="">Me \(whoever is viewing\)<\/option>/);
  });

  it('offers relative date tokens on date clauses', () => {
    const html = render(
      <FilterEditor
        value={{ combinator: 'and', clauses: [{ fieldId: 7, operator: 'gte', value: '$today-7d' }] }}
        onChange={vi.fn()}
        fields={[field(7, 'date')]}
        users={users}
        systemFields={[]}
      />,
    );
    expect(html).toMatch(/<option value="\$today-7d" selected="">7 days ago<\/option>/);
    expect(html).not.toContain('Record info');
  });
});

describe('FieldEditor', () => {
  it('renders nothing for computed fields — they are never written', () => {
    expect(render(<FieldEditor field={field(1, 'rollup')} value="" onChange={vi.fn()} users={users} />)).toBe('');
  });

  it('labels a checkbox with the field name in form density', () => {
    const html = render(<FieldEditor field={field(1, 'boolean')} value={true} onChange={vi.fn()} users={users} />);
    expect(html).toContain('Field 1');
    expect(html).toContain('checked=""');
  });
});
