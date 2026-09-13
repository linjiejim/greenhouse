import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TableField, TableRecord, TableView } from '../../lib/api/tables';
import { TablesGridToolbar } from './grid-toolbar';
import { RecordDetailContent } from './record-detail-drawer';
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
  it('renders crowded toolbar operations as accessible icon buttons with upward tooltips', () => {
    const html = renderToStaticMarkup(
      <TablesGridToolbar
        views={views}
        selectedViewId="9"
        search=""
        filterCount={2}
        canEdit
        canBuild
        pasting={false}
        onSelectView={vi.fn()}
        onSearch={vi.fn()}
        onOpenFilters={vi.fn()}
        onSaveView={vi.fn()}
        onOpenRecycleBin={vi.fn()}
        onOpenForms={vi.fn()}
        onAddField={vi.fn()}
        onAddRecord={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Filter records · 2"');
    expect(html).toContain('aria-label="Save view"');
    expect(html).toContain('aria-label="Recycle bin"');
    expect(html).toContain('aria-label="Manage forms"');
    expect(html).toContain('aria-label="Add field"');
    expect(html).toContain('aria-label="Add record"');
    expect(html.match(/bottom-full mb-1\.5/g)).toHaveLength(6);
    expect(html).toContain('bg-primary-500');
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
        tableName="Launch table"
        record={record}
        fields={fields}
        users={[{ id: 'user-1', nickname: 'Jim', email: 'jim@example.com' }]}
        canEdit
        onClose={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(html).toContain('Record #42');
    expect(html).toContain('Revision 3');
    expect(html).toContain('Launch review');
    expect(html).toContain('Planned');
    expect(html).toContain('Launch review · Planned');
    expect(html).toContain('Computed');
    expect(html).toContain('aria-label="Close record details"');
  });
});
