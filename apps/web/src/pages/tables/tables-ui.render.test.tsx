import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TableDefinition, TableField, TableRecord, TableView } from '../../lib/api/tables';
import { TablesViewToolbar } from './view-toolbar';
import { ViewSwitcher } from './views/view-switcher';
import { RecordDetailContent } from './record-drawer/record-detail-drawer';
import { RecordRowActions } from './record-row-actions';

const record: TableRecord = {
  id: 42,
  table_id: 7,
  values: { '1': 'Launch review', '2': 'planned' },
  computed_values: { '3': 'Launch review · Planned' },
  revision: 3,
  created_by: 'user-1',
  updated_by: 'user-1',
  created_at: '2026-07-28T01:00:00.000Z',
  updated_at: '2026-07-28T02:00:00.000Z',
  deleted_at: null,
};

const fields: TableField[] = [
  {
    id: 1,
    table_id: 7,
    name: 'Name',
    type: 'text',
    required: true,
    is_primary: true,
    config: '{}',
    position: 0,
    created_by: 'user-1',
    created_at: record.created_at,
    updated_at: record.created_at,
    archived_at: null,
  },
  {
    id: 2,
    table_id: 7,
    name: 'Status',
    type: 'single_select',
    required: false,
    is_primary: false,
    config: JSON.stringify({ options: [{ id: 'planned', label: 'Planned' }] }),
    position: 1,
    created_by: 'user-1',
    created_at: record.created_at,
    updated_at: record.created_at,
    archived_at: null,
  },
  {
    id: 3,
    table_id: 7,
    name: 'Launch label',
    type: 'formula',
    required: false,
    is_primary: false,
    config: '{}',
    position: 2,
    created_by: 'user-1',
    created_at: record.created_at,
    updated_at: record.created_at,
    archived_at: null,
  },
];

const table: Pick<TableDefinition, 'id' | 'base_id' | 'name'> = { id: 7, base_id: 3, name: 'Launch table' };
const jim = { id: 'user-1', nickname: 'Jim', email: 'jim@example.com' };

const views: TableView[] = [
  {
    id: 9,
    table_id: 7,
    name: 'Launch work',
    type: 'grid',
    scope: 'shared',
    owner_id: null,
    config: '{}',
    position: 0,
    revision: 1,
    created_by: 'user-1',
    created_at: record.created_at,
    updated_at: record.updated_at,
  },
];

describe('Tables compact grid controls', () => {
  it('labels the primary add action and keeps secondary controls compact and accessible', () => {
    const html = renderToStaticMarkup(
      <TablesViewToolbar
        viewControls={
          <ViewSwitcher
            views={views}
            selectedView={views[0]!}
            canCreateView
            canChangeView
            onSelectView={vi.fn()}
            onNewView={vi.fn()}
            onOpenFields={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        }
        search=""
        filterCount={2}
        canEdit
        canBuild
        pasting={false}
        onSearch={vi.fn()}
        onOpenFilters={vi.fn()}
        onOpenRecycleBin={vi.fn()}
        onOpenForms={vi.fn()}
        onAddField={vi.fn()}
        onAddRecord={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Filter records · 2"');
    expect(html).toContain('aria-label="New view"');
    expect(html).toContain('aria-label="Fields"');
    expect(html).toContain('aria-label="View settings"');
    expect(html).toContain('aria-label="View"');
    expect(html).toContain('data-testid="tables-more-actions"');
    expect(html).not.toContain('aria-label="Recycle bin"');
    expect(html).not.toContain('aria-label="Manage forms"');
    expect(html).not.toContain('aria-label="Add field"');
    expect(html).toMatch(/<button[^>]*bg-primary-600[^>]*>.*Add record<\/button>/);
    expect(html.match(/bottom-full mb-1\.5/g)).toHaveLength(5);
    expect(html).toMatch(/aria-hidden="true">2<\/span>/);
  });

  it('always exposes View while keeping edit and delete behind record edit permission', () => {
    const viewerHtml = renderToStaticMarkup(
      <RecordRowActions record={record} canEdit={false} onView={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(viewerHtml).toContain('aria-label="View record"');
    expect(viewerHtml).not.toContain('aria-label="Edit record"');
    expect(viewerHtml).not.toContain('aria-label="Delete record"');

    const editorHtml = renderToStaticMarkup(
      <RecordRowActions record={record} canEdit onView={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(editorHtml).toContain('aria-label="View record"');
    expect(editorHtml).toContain('aria-label="Edit record"');
    expect(editorHtml).toContain('aria-label="Delete record"');
  });

  it('renders stored, select and computed values in the read-only record detail content', () => {
    const html = renderToStaticMarkup(
      <RecordDetailContent
        table={table}
        record={record}
        fields={fields}
        users={[jim]}
        usersById={new Map([[jim.id, jim]])}
        canEdit
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRecordChanged={vi.fn()}
      />,
    );

    expect(html).toContain('Record #42');
    expect(html).toContain('Revision 3');
    expect(html).toContain('Launch review');
    expect(html).toMatch(/<h1[^>]*>.*Launch review.*<\/h1>/);
    expect(html).toContain('Planned');
    expect(html).toContain('Launch review · Planned');
    expect(html).toContain('Computed');
    expect(html).toContain('aria-label="Close record details"');
  });

  it('never takes the record title from a primary field outside the authorized field list', () => {
    const html = renderToStaticMarkup(
      <RecordDetailContent
        table={table}
        record={record}
        fields={[fields[1]!]}
        users={[jim]}
        usersById={new Map([[jim.id, jim]])}
        canEdit={false}
        onEdit={vi.fn()}
        onRecordChanged={vi.fn()}
      />,
    );
    expect(html).toMatch(/<h1[^>]*>.*#42.*<\/h1>/);
    expect(html).not.toContain('Launch review');
    expect(html).toContain('Planned');
  });
});
