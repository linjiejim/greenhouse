/** @vitest-environment happy-dom */

/**
 * The grid body's empty and read-only states and its accessible names: no
 * records says whether a filter hides them; a viewer on a shared view gets no
 * column-options button that would open nothing; a group header is named by
 * its label and count; kanban and gallery cards by their title.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryViewBody } from './gallery';
import { GridViewBody } from './grid';
import { KanbanViewBody } from './kanban';
import { bodyProps, fixtureField, fixtureRecord, mountBody, type MountedBody } from './view-test-fixtures';

const api = vi.hoisted(() => ({ aggregateTableRecords: vi.fn() }));
vi.mock('../../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/tables')>()),
  ...api,
}));

const primary = fixtureField(1, 'Name', 'text');
const stage = fixtureField(2, 'Stage', 'single_select', {
  options: [
    { id: 'lead', label: 'Lead' },
    { id: 'won', label: 'Won' },
  ],
});
const schemaFields = [primary, stage];
const acme = fixtureRecord(5, { '1': 'Acme', '2': 'lead' });

let mounted: MountedBody | null = null;

beforeEach(() => {
  api.aggregateTableRecords.mockResolvedValue([{ group: 'lead', value: 3 }]);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const text = () => mounted!.container.textContent ?? '';

describe('GridViewBody', () => {
  it('says no record matches when a search or filter hides them, and that the table is empty otherwise', async () => {
    mounted = await mountBody(GridViewBody, bodyProps({ config: {}, schemaFields, query: { search: 'zzz' } }));
    expect(text()).toContain('No records match');
    expect(text()).toContain('Clear the search');

    await mounted.rerender(bodyProps({ config: {}, schemaFields }));
    expect(text()).toContain('No records yet');

    await mounted.rerender(bodyProps({ config: {}, schemaFields, records: [acme] }));
    expect(text()).not.toContain('No records');
  });

  it('offers column options only to someone who can change the view or the fields', async () => {
    const viewer = { canEdit: false, canCreate: false, canBuild: false, canChangeView: false };
    mounted = await mountBody(
      GridViewBody,
      bodyProps({ config: {}, schemaFields, records: [acme], permissions: viewer }),
    );
    expect(mounted.container.querySelector('button[aria-label="Name column options"]')).toBeNull();

    await mounted.rerender(bodyProps({ config: {}, schemaFields, records: [acme] }));
    expect(mounted.container.querySelector('button[aria-label="Name column options"]')).not.toBeNull();
  });

  it('names each group header by its label and count, not just "Collapse group"', async () => {
    mounted = await mountBody(
      GridViewBody,
      bodyProps({ config: { groupBy: { fieldId: stage.id } }, schemaFields, records: [acme] }),
    );
    const header = mounted.container.querySelector('[data-testid="group-header-lead"] button')!;
    expect(header.hasAttribute('aria-label')).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.textContent).toContain('Lead');
    expect(header.textContent).toContain('3');
  });
});

describe('record cards', () => {
  it('are named by their title on the kanban and in the gallery', async () => {
    mounted = await mountBody(
      KanbanViewBody,
      bodyProps({ config: { kanban: { groupFieldId: stage.id } }, schemaFields, records: [acme] }),
    );
    const card = mounted.container.querySelector('[data-testid="kanban-card-5"]')!;
    expect(card.hasAttribute('aria-label')).toBe(false);
    expect(document.getElementById(card.getAttribute('aria-labelledby')!)?.textContent).toBe('Acme');
    mounted.unmount();

    mounted = await mountBody(GalleryViewBody, bodyProps({ config: {}, schemaFields, records: [acme] }));
    const tile = mounted.container.querySelector('[data-testid="gallery-card-5"]')!;
    expect(document.getElementById(tile.getAttribute('aria-labelledby')!)?.textContent).toBe('Acme');
  });
});
