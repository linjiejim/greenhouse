/** @vitest-environment happy-dom */

/**
 * The import wizard under real interaction: a file upload lands on the mapping
 * step with the server's suggestions, the user re-maps columns (skip, an
 * existing field, a new field with its own name and type), duplicate targets
 * block the check, the header toggle relabels columns, and the request the
 * dry run and the commit receive is exactly the mapping on screen.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableImportPreview } from '@greenhouse/types/tables';
import { I18nProvider } from '../../../lib/i18n';
import type { TableDefinition, TableField } from '../../../lib/api/tables';
import { TablesImportWizard } from './import-wizard';

const api = vi.hoisted(() => ({
  uploadTableImport: vi.fn(),
  validateTableImport: vi.fn(),
  commitTableImportAll: vi.fn(),
}));
vi.mock('../../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/tables')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T00:00:00.000Z';
const table: TableDefinition = {
  id: 7,
  base_id: 3,
  name: 'Deals',
  description: null,
  position: 0,
  schema_revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

function field(id: number, name: string, type: TableField['type']): TableField {
  return {
    id,
    table_id: 7,
    name,
    type,
    required: id === 1,
    is_primary: id === 1,
    config: '{}',
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

const fields = [field(1, 'Name', 'text'), field(2, 'Amount', 'number'), field(3, 'Files', 'attachment')];

const preview: TableImportPreview = {
  importId: 'imp_1',
  fileName: 'deals.csv',
  rowCount: 2,
  expiresAt: stamp,
  columns: [
    { index: 0, header: 'Name', samples: ['Acme', 'Globex'], inferredType: 'text', suggestion: { fieldId: 1 } },
    {
      index: 1,
      header: 'Region',
      samples: ['North', 'South'],
      inferredType: 'single_select',
      suggestion: { create: { name: 'Region', type: 'single_select' } },
    },
    { index: 2, header: 'Value', samples: ['1,200', '30'], inferredType: 'number' },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onImported = vi.fn();

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(canBuild = true) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <TablesImportWizard
          open
          table={table}
          fields={fields}
          canBuild={canBuild}
          onClose={() => undefined}
          onImported={onImported}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

function q<T extends Element>(testId: string): T {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`missing ${testId}`);
  return element as T;
}

async function chooseFile() {
  const input = q<HTMLInputElement>('tables-import-file');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'deals.csv')] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

async function select(testId: string, value: string) {
  const element = q<HTMLSelectElement>(testId);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(testId: string, value: string) {
  const input = q<HTMLInputElement>(testId);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function optionValues(testId: string): string[] {
  return [...q<HTMLSelectElement>(testId).querySelectorAll('option')].map((option) => option.value);
}

beforeEach(() => {
  api.uploadTableImport.mockResolvedValue(preview);
  api.validateTableImport.mockResolvedValue({
    totalRows: 2,
    validRows: 1,
    failed: [{ row: 3, errors: ['Amount: "30x" is not a number'] }],
    failedCount: 1,
    missingRequired: [],
  });
  api.commitTableImportAll.mockImplementation(async (_tableId, importId, _input, onProgress) => {
    const progress = {
      importId,
      status: 'committed',
      totalRows: 2,
      processedRows: 2,
      result: {
        created: 1,
        failed: [{ row: 3, errors: ['Amount: "30x" is not a number'] }],
        failedCount: 1,
        createdFieldIds: [9],
      },
    };
    onProgress(progress);
    return progress;
  });
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

describe('TablesImportWizard — mapping', () => {
  it('starts from the server suggestions and sends exactly the mapping on screen', async () => {
    await mount();
    await chooseFile();
    expect(api.uploadTableImport).toHaveBeenCalledWith(7, expect.any(File));
    expect(document.body.textContent).toContain('deals.csv · 2 rows · 3 columns');

    // Suggestions: Name → existing field, Region → new single select, Value → skipped.
    expect(q<HTMLSelectElement>('tables-import-destination-0').value).toBe('field:1');
    expect(q<HTMLSelectElement>('tables-import-destination-1').value).toBe('create');
    expect(q<HTMLInputElement>('tables-import-name-1').value).toBe('Region');
    expect(q<HTMLSelectElement>('tables-import-type-1').value).toBe('single_select');
    expect(q<HTMLSelectElement>('tables-import-destination-2').value).toBe('skip');
    // Attachments and computed fields are never offered.
    expect(optionValues('tables-import-destination-2')).toEqual(['skip', 'field:1', 'field:2', 'create']);

    // Two columns into one field block the check…
    await select('tables-import-destination-2', 'field:1');
    expect(document.body.textContent).toContain('“Name” receives more than one column');
    expect(q<HTMLButtonElement>('tables-import-check-button').disabled).toBe(true);
    // …until the column goes to its own field.
    await select('tables-import-destination-2', 'field:2');
    expect(q<HTMLButtonElement>('tables-import-check-button').disabled).toBe(false);

    await type('tables-import-name-1', 'Sales region');
    await select('tables-import-type-1', 'text');

    await act(async () => q<HTMLButtonElement>('tables-import-check-button').click());
    await flush();
    expect(api.validateTableImport).toHaveBeenCalledWith(7, 'imp_1', {
      mapping: [
        { column: 0, fieldId: 1 },
        { column: 1, create: { name: 'Sales region', type: 'text' } },
        { column: 2, fieldId: 2 },
      ],
      hasHeader: true,
      createOptions: false,
      timezone: expect.any(String),
    });
    expect(q('tables-import-check').textContent).toContain('1 rows are ready to import');
    expect(q('tables-import-failures').textContent).toContain('Row 3');

    await act(async () => q<HTMLButtonElement>('tables-import-start').click());
    await flush();
    expect(api.commitTableImportAll).toHaveBeenCalledWith(
      7,
      'imp_1',
      expect.objectContaining({ mapping: expect.any(Array), hasHeader: true }),
      expect.any(Function),
    );
    expect(q('tables-import-result').textContent).toContain('1 records created');
    expect(q('tables-import-result').textContent).toContain('1 new fields added');
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('relabels columns without a header row and offers no new fields to non-builders', async () => {
    await mount(false);
    await chooseFile();
    // A non-builder never gets a "create" suggestion or option.
    expect(q<HTMLSelectElement>('tables-import-destination-1').value).toBe('skip');
    expect(optionValues('tables-import-destination-1')).not.toContain('create');

    const toggle = document.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(q('tables-import-column-0').textContent).toContain('Column A');
    // The former header row is now data and leads the samples.
    expect(q('tables-import-column-0').textContent).toContain('Name · Acme · Globex');
    expect(document.body.textContent).toContain('deals.csv · 3 rows · 3 columns');

    await act(async () => q<HTMLButtonElement>('tables-import-check-button').click());
    await flush();
    expect(api.validateTableImport).toHaveBeenCalledWith(7, 'imp_1', {
      mapping: [{ column: 0, fieldId: 1 }],
      hasHeader: false,
      createOptions: false,
      timezone: expect.any(String),
    });
  });

  it('after an import stopped part-way, only offers to resume it', async () => {
    api.commitTableImportAll.mockImplementationOnce(async (_tableId, importId, _input, onProgress) => {
      onProgress({ importId, status: 'committing', totalRows: 1000, processedRows: 300 });
      throw new Error('Network error');
    });
    await mount();
    await chooseFile();
    await act(async () => q<HTMLButtonElement>('tables-import-check-button').click());
    await flush();
    const backLabel = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Back');
    expect(backLabel()).toBeDefined();
    await act(async () => q<HTMLButtonElement>('tables-import-start').click());
    await flush();

    // Back to the check step, but the mapping (and a new file) would re-import the 300 rows.
    expect(document.body.textContent).toContain('Network error');
    expect(backLabel()).toBeUndefined();
    expect(q('tables-import-resume-hint').textContent).toContain('300 of 1000 rows were processed');
    expect(q<HTMLButtonElement>('tables-import-start').textContent).toBe('Resume import');

    await act(async () => q<HTMLButtonElement>('tables-import-start').click());
    await flush();
    expect(api.commitTableImportAll).toHaveBeenCalledTimes(2);
    expect(api.commitTableImportAll).toHaveBeenLastCalledWith(7, 'imp_1', expect.any(Object), expect.any(Function));
    expect(api.validateTableImport).toHaveBeenCalledTimes(1);
    expect(q('tables-import-result').textContent).toContain('1 records created');
  });

  it('shows a server refusal instead of a mapping', async () => {
    api.uploadTableImport.mockRejectedValueOnce(new Error('The file has more than 10,000 rows'));
    await mount();
    await chooseFile();
    expect(document.body.textContent).toContain('The file has more than 10,000 rows');
    expect(document.querySelector('[data-testid="tables-import-mapping"]')).toBeNull();
  });
});
