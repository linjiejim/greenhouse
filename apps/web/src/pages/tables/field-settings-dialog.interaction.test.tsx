/** @vitest-environment happy-dom */

/**
 * Field settings for a select: removing an option row keeps every other
 * option's id, so records that pointed at "Doing" still read "Doing" (the old
 * one-per-line textarea re-assigned ids by line position).
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import type { TableDefinition, TableField } from '../../lib/api/tables';
import { FieldSettingsDialog } from './field-settings-dialog';

const api = vi.hoisted(() => ({
  createTableField: vi.fn(),
  updateTableField: vi.fn(),
  getTableSchema: vi.fn(),
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
  name: 'Tasks',
  description: null,
  position: 0,
  schema_revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};
const status: TableField = {
  id: 2,
  table_id: 7,
  name: 'Status',
  type: 'single_select',
  required: false,
  is_primary: false,
  config: JSON.stringify({
    options: [
      { id: 'todo', label: 'To do' },
      { id: 'doing', label: 'Doing' },
      { id: 'done', label: 'Done' },
    ],
  }),
  position: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  api.updateTableField.mockResolvedValue(status);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label,
  ) as HTMLButtonElement;

describe('FieldSettingsDialog — select options', () => {
  it('removes one option without shifting the others’ ids, and adds a new one with a fresh id', async () => {
    const onSaved = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <FieldSettingsDialog
            field={status}
            table={table}
            tables={[table]}
            fields={[status]}
            onClose={vi.fn()}
            onSaved={onSaved}
            onArchive={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(
      [...document.querySelectorAll<HTMLInputElement>('[data-testid="option-row"] input')].map((input) => input.value),
    ).toEqual(['To do', 'Doing', 'Done']);

    await act(async () => button('Remove To do').click());
    await act(async () => button('Add option').click());
    const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="option-row"] input');
    const added = inputs[inputs.length - 1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(added, 'Blocked');
      added.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save field').click());

    expect(api.updateTableField).toHaveBeenCalledWith(2, {
      name: 'Status',
      required: false,
      config: {
        options: [
          { id: 'doing', label: 'Doing' },
          { id: 'done', label: 'Done' },
          { id: 'blocked-1', label: 'Blocked' },
        ],
      },
    });
  });
});
