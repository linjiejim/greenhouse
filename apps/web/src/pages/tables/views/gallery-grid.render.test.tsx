/** @vitest-environment happy-dom */

/**
 * Rendering of the gallery (cover = the first image among the cover field's
 * files, read through the authenticated Drive content route; primary field as
 * the title; card fields) and of the grid's grouping (collapsible headers with
 * the group's total from the aggregate), system columns and row height.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryViewBody } from './gallery';
import { GridViewBody } from './grid';
import { resetRecordCoverCacheForTest } from './record-cover';
import { bodyProps, fixtureField, fixtureRecord, flush, mountBody, type MountedBody } from './view-test-fixtures';

const mocks = vi.hoisted(() => ({ aggregateTableRecords: vi.fn(), authFetch: vi.fn() }));
vi.mock('../../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/tables')>()),
  aggregateTableRecords: mocks.aggregateTableRecords,
}));
vi.mock('../../../lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/auth')>()),
  authFetch: mocks.authFetch,
}));

const primary = fixtureField(1, 'Name', 'text');
const stage = fixtureField(2, 'Stage', 'single_select', {
  options: [
    { id: 'lead', label: 'Lead' },
    { id: 'won', label: 'Won' },
  ],
});
const photos = fixtureField(3, 'Photos', 'attachment');
const amount = fixtureField(4, 'Amount', 'number');

let mounted: MountedBody | null = null;
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  resetRecordCoverCacheForTest();
  URL.createObjectURL = vi.fn(() => 'blob:cover');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  vi.clearAllMocks();
});

describe('GalleryViewBody', () => {
  it('shows the first image of the cover field, the primary field as title, then card fields', async () => {
    mocks.authFetch.mockImplementation(async (url: string) =>
      url.endsWith('/11/content')
        ? new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })
        : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
    );
    const props = bodyProps({
      config: { gallery: { coverFieldId: photos.id, fit: 'contain' }, fieldIds: [primary.id, amount.id] },
      schemaFields: [primary, stage, photos, amount],
      fields: [primary, amount],
      records: [fixtureRecord(5, { '1': 'Acme', '3': [11, 12], '4': 1200 }), fixtureRecord(6, { '4': 5 })],
    });
    mounted = await mountBody(GalleryViewBody, props);
    await flush();

    const acme = mounted.container.querySelector('[data-testid="gallery-card-5"]')!;
    expect(mocks.authFetch).toHaveBeenCalledWith('/api/drive/files/11/content');
    expect(mocks.authFetch).toHaveBeenCalledWith('/api/drive/files/12/content');
    const cover = acme.querySelector('img[data-testid="record-cover"]') as HTMLImageElement;
    expect(cover.getAttribute('src')).toBe('blob:cover');
    expect(cover.className).toContain('object-contain');
    expect(acme.textContent).toContain('Acme');
    expect(acme.textContent).toContain('Amount');
    expect(acme.textContent).toContain('1,200');

    // No title value: the record still has a name; no files: the slot keeps the grid aligned.
    const untitled = mounted.container.querySelector('[data-testid="gallery-card-6"]')!;
    expect(untitled.textContent).toContain('Untitled #6');
    expect(untitled.querySelector('[data-testid="record-cover-placeholder"]')).not.toBeNull();

    await act(async () => (acme as HTMLElement).click());
    expect(props.onOpenRecord).toHaveBeenCalledWith(props.records[0]);
  });
});

describe('GridViewBody grouping', () => {
  it('draws a collapsible header per group with the group’s total from the aggregate', async () => {
    mocks.aggregateTableRecords.mockResolvedValue([
      { group: 'lead', value: 12 },
      { group: 'won', value: 1 },
      { group: null, value: 3 },
    ]);
    const props = bodyProps({
      config: { groupBy: { fieldId: stage.id }, systemFields: ['created_by'], rowHeight: 'tall' },
      schemaFields: [primary, stage],
      records: [
        fixtureRecord(5, { '1': 'Acme', '2': 'lead' }),
        fixtureRecord(6, { '1': 'Bolt', '2': 'lead' }),
        fixtureRecord(7, { '1': 'Crane', '2': 'won' }, { created_by: 'u2' }),
        fixtureRecord(8, { '1': 'Delta' }),
      ],
      query: { where: { combinator: 'and', clauses: [{ fieldId: 1, operator: 'contains', value: 'a' }] } },
    });
    mounted = await mountBody(GridViewBody, props);

    const headers = [...mounted.container.querySelectorAll('[data-testid^="group-header-"]')];
    expect(headers.map((row) => row.getAttribute('data-testid'))).toEqual([
      'group-header-lead',
      'group-header-won',
      'group-header-none',
    ]);
    expect(headers.map((row) => row.querySelector('[data-testid="group-count"]')?.textContent)).toEqual([
      '12',
      '1',
      '3',
    ]);
    expect(headers[0]!.textContent).toContain('Lead');
    expect(headers[2]!.textContent).toContain('No value');
    // The counts aggregate over the same query as the rows.
    expect(mocks.aggregateTableRecords).toHaveBeenCalledWith(7, {
      operation: 'count',
      groupBy: { fieldId: stage.id },
      query: { where: props.query.where },
      sort: 'group_asc',
      limit: 100,
      timezone: expect.any(String),
    });

    // System columns render after the fields; tall rows pad their cells.
    expect(mounted.container.querySelector('[data-testid="system-column-created_by"]')?.textContent).toBe('Created by');
    expect(mounted.container.textContent).toContain('Ann');
    expect(mounted.container.querySelector('tbody tr:not([data-testid]) td')?.className).toContain('py-5');

    const rowsBefore = mounted.container.querySelectorAll('tbody tr').length;
    await act(async () => (headers[0]!.querySelector('button') as HTMLButtonElement).click());
    expect(mounted.container.querySelectorAll('tbody tr').length).toBe(rowsBefore - 2);
    expect(mounted.container.textContent).not.toContain('Acme');
    expect(headers[0]!.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  });
});
