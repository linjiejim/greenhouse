/** @vitest-environment happy-dom */

/**
 * Deleting (archiving) a table apps use (apps spec D6): the server answers 409
 * `used_by_apps`, the delete dialog hands over to the references (each app
 * linking to its builder), and "Archive anyway" resends with `confirm`. Other
 * failures stay in the delete dialog as before.
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { TablesRequestError, type TableDefinition } from '../../lib/api/tables';
import { DeleteDialog, type DeletionTarget } from './delete-dialog';

const api = vi.hoisted(() => ({
  archiveTableDefinition: vi.fn(),
  archiveTableBase: vi.fn(),
  deleteTableDashboard: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T00:00:00.000Z';
const table: TableDefinition = {
  id: 7,
  base_id: 3,
  name: 'Requests',
  description: null,
  position: 0,
  schema_revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

const onDeleted = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement;

/** The sidebar's mount: the dialog stays mounted and the host clears its target. */
function Host() {
  const [target, setTarget] = useState<DeletionTarget | null>({ kind: 'table', value: table });
  return (
    <DeleteDialog
      target={target}
      onClose={() => setTarget(null)}
      onDeleted={(deleted) => {
        setTarget(null);
        onDeleted(deleted);
      }}
    />
  );
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <Host />
      </I18nProvider>,
    ),
  );
  await flush();
}

const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label) as HTMLButtonElement;

async function click(element: HTMLElement | null | undefined) {
  expect(element, 'element to click').toBeTruthy();
  await act(async () => element!.click());
  await flush();
}

beforeEach(() => {
  onDeleted.mockReset();
  api.archiveTableDefinition.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
});

describe('DeleteDialog — a table apps use', () => {
  it('hands over to the references, then archives anyway with confirm', async () => {
    api.archiveTableDefinition
      .mockRejectedValueOnce(
        new TablesRequestError('Apps use this table', 409, {
          reason: 'used_by_apps',
          references: [{ appId: 12, name: 'Purchases', where: 'Apply · My requests' }],
        }),
      )
      .mockResolvedValueOnce(table);
    await mount();
    await click(buttonNamed('Delete'));

    expect(api.archiveTableDefinition).toHaveBeenCalledWith(7);
    expect(onDeleted).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-testid="app-references-dialog"]')!;
    expect(document.body.textContent).toContain('Apps use the table “Requests”');
    expect(dialog.querySelector('a[href="#/apps/12/edit"]')?.textContent).toBe('Purchases');
    expect(document.body.textContent).not.toContain('Apps use this table');

    await click(buttonNamed('Archive anyway'));
    expect(api.archiveTableDefinition).toHaveBeenLastCalledWith(7, { confirm: true });
    expect(onDeleted).toHaveBeenCalledWith({ kind: 'table', value: table });
    expect(document.querySelector('[data-testid="app-references-dialog"]')).toBeNull();
  });

  it('keeps other failures in the delete dialog', async () => {
    api.archiveTableDefinition.mockRejectedValueOnce(new TablesRequestError('Only the Base owner', 403, undefined));
    await mount();
    await click(buttonNamed('Delete'));
    expect(document.body.textContent).toContain('Only the Base owner');
    expect(document.querySelector('[data-testid="app-references-dialog"]')).toBeNull();
  });
});
