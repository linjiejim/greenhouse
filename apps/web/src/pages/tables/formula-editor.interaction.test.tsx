/** @vitest-environment happy-dom */

/**
 * The field dialog's formula and lookup sections under real interaction:
 * field / function autocomplete from the keyboard and the mouse, the live
 * parse error with its position highlighted (and saving blocked), the result
 * type following the formula, the stored AST on save, an existing formula
 * shown as text, and the lookup configuration.
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
const table = (id: number, name: string): TableDefinition => ({
  id,
  base_id: 3,
  name,
  description: null,
  position: 0,
  schema_revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
});
const deals = table(7, 'Deals');
const customers = table(8, 'Customers');

function field(id: number, name: string, type: TableField['type'], config: object = {}, tableId = 7): TableField {
  return {
    id,
    table_id: tableId,
    name,
    type,
    required: false,
    is_primary: id === 1,
    config: JSON.stringify(config),
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

const fields = [
  field(1, 'Name', 'text'),
  field(2, '数量', 'number'),
  field(3, 'Start', 'date'),
  field(4, 'Due', 'date'),
  field(5, 'Total', 'rollup', { rollup: { relationFieldId: 6, targetFieldId: 21, aggregation: 'sum' } }),
  field(6, 'Customer', 'relation', { relation: { targetTableId: 8, multiple: true } }),
];
const customerFields = [
  field(20, 'Company', 'text', {}, 8),
  field(21, 'Spend', 'number', {}, 8),
  field(22, 'Owner', 'user', {}, 8),
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onSaved = vi.fn(async () => undefined);

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function open(target: TableField | 'new') {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <FieldSettingsDialog
          field={target}
          table={deals}
          tables={[deals, customers]}
          fields={fields}
          onClose={() => undefined}
          onSaved={onSaved}
          onArchive={() => undefined}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

const byTestId = <T extends Element = HTMLElement>(id: string) =>
  document.body.querySelector<T>(`[data-testid="${id}"]`);
const formulaInput = () => byTestId<HTMLTextAreaElement>('formula-editor-input')!;

function selects(): HTMLSelectElement[] {
  return [...document.body.querySelectorAll('select')];
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

async function fillName(name: string) {
  const input = document.body.querySelector('input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Replace the formula text and put the caret at `caret` (default: the end). */
async function typeFormula(text: string, caret = text.length) {
  const textarea = formulaInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function press(key: string) {
  await act(async () => {
    formulaInput().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

function suggestionLabels(): string[] {
  return [...document.body.querySelectorAll('[data-testid="formula-suggestions"] [role="option"]')].map(
    (option) => option.textContent ?? '',
  );
}

async function save() {
  const button = [...document.body.querySelectorAll('button')].find((entry) => entry.textContent === 'Save field')!;
  await act(async () => button.click());
  await flush();
}

beforeEach(() => {
  api.createTableField.mockResolvedValue(field(30, 'New', 'formula'));
  api.updateTableField.mockResolvedValue(field(30, 'New', 'formula'));
  api.getTableSchema.mockResolvedValue({ table: customers, fields: customerFields, views: [] });
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

describe('FieldSettingsDialog · formula editor', () => {
  it('completes fields and functions, follows the result type and saves the parsed AST', async () => {
    await open('new');
    await fillName('Size');
    await choose(selects()[0]!, 'formula');

    // `{` offers stored fields only (the rollup is computed), filtered by what follows.
    await typeFormula('IF({');
    expect(suggestionLabels()).toEqual([
      '{Name}Text',
      '{数量}Number',
      '{Start}Date',
      '{Due}Date',
      '{Customer}Relation',
    ]);
    await typeFormula('IF({数');
    expect(suggestionLabels()).toEqual(['{数量}Number']);
    await press('Enter');
    expect(formulaInput().value).toBe('IF({数量}');
    expect(byTestId('formula-suggestions')).toBeNull();

    await typeFormula('IF({数量} > 10, "Big", "Small")');
    expect(byTestId('formula-error')).toBeNull();
    expect(byTestId('formula-result-type')?.textContent).toBe('Returns Text');

    await save();
    expect(api.createTableField).toHaveBeenCalledWith(7, {
      name: 'Size',
      type: 'formula',
      required: false,
      config: {
        formula: {
          resultType: 'text',
          expression: {
            type: 'function',
            name: 'if',
            args: [
              {
                type: 'binary',
                operator: 'gt',
                left: { type: 'field', fieldId: 2 },
                right: { type: 'literal', value: 10 },
              },
              { type: 'literal', value: 'Big' },
              { type: 'literal', value: 'Small' },
            ],
          },
        },
      },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('inserts a function picked with the mouse and moves the caret inside its parentheses', async () => {
    await open('new');
    await choose(selects()[0]!, 'formula');
    await typeFormula('dated');
    expect(suggestionLabels().map((label) => label.split('(')[0])).toEqual(['DATEDIFF']);
    const option = byTestId('formula-suggestion-fn:datediff')!;
    await act(async () => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(formulaInput().value).toBe('DATEDIFF(');
    expect(formulaInput().selectionStart).toBe(9);

    await typeFormula('DATEDIFF({Due}, {Start}, "days")');
    expect(byTestId('formula-result-type')?.textContent).toBe('Returns Number');
    // The result type followed the formula.
    expect(selects()[1]!.value).toBe('number');
  });

  it('shows the parse error at its position and refuses to save', async () => {
    await open('new');
    await fillName('Broken');
    await choose(selects()[0]!, 'formula');
    await typeFormula('{数量} + {Nope}');
    expect(byTestId('formula-error')?.textContent).toContain('There is no field named Nope.');
    expect(byTestId('formula-error-mark')?.textContent).toBe('{Nope}');
    expect(formulaInput().getAttribute('aria-invalid')).toBe('true');

    await typeFormula('{Name} + 1');
    expect(byTestId('formula-error')?.textContent).toContain('Text can’t be used with +. Use & to join text.');
    expect(byTestId('formula-error-mark')?.textContent).toBe('{Name}');

    const select = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Select in formula',
    )!;
    await act(async () => select.click());
    expect([formulaInput().selectionStart, formulaInput().selectionEnd]).toEqual([0, 6]);

    await save();
    expect(api.createTableField).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Fix the formula before saving');
  });

  it('closes the suggestion list on Escape without closing the dialog', async () => {
    await open('new');
    await choose(selects()[0]!, 'formula');
    await typeFormula('{');
    expect(byTestId('formula-suggestions')).not.toBeNull();
    await press('Escape');
    expect(byTestId('formula-suggestions')).toBeNull();
    expect(formulaInput()).not.toBeNull();
  });

  it('shows a stored formula as text, keeps its result type and re-sends it only when edited', async () => {
    const stored = field(9, 'Days', 'formula', {
      formula: {
        resultType: 'text',
        expression: {
          type: 'function',
          name: 'datediff',
          args: [
            { type: 'field', fieldId: 4 },
            { type: 'field', fieldId: 3 },
          ],
        },
      },
    });
    await open(stored);
    expect(formulaInput().value).toBe('DATEDIFF({Due}, {Start})');
    expect(selects()[1]!.value).toBe('text');
    await save();
    expect(api.updateTableField).toHaveBeenLastCalledWith(9, { name: 'Days', required: false, config: undefined });

    await typeFormula('DATEDIFF({Due}, {Start}, "weeks")');
    await save();
    expect(api.updateTableField).toHaveBeenLastCalledWith(9, {
      name: 'Days',
      required: false,
      config: {
        formula: {
          resultType: 'text',
          expression: {
            type: 'function',
            name: 'datediff',
            args: [
              { type: 'field', fieldId: 4 },
              { type: 'field', fieldId: 3 },
              { type: 'literal', value: 'weeks' },
            ],
          },
        },
      },
    });
  });

  it('lets an older formula that fails today’s checks be renamed without touching it', async () => {
    const legacy = field(10, 'Joined', 'formula', {
      formula: {
        resultType: 'text',
        expression: {
          type: 'binary',
          operator: 'add',
          left: { type: 'field', fieldId: 1 },
          right: { type: 'field', fieldId: 1 },
        },
      },
    });
    await open(legacy);
    expect(formulaInput().value).toBe('{Name} + {Name}');
    expect(byTestId('formula-error')?.textContent).toContain('Use & to join text');
    await fillName('Joined twice');
    await save();
    expect(api.updateTableField).toHaveBeenCalledWith(10, { name: 'Joined twice', required: false, config: undefined });
  });
});

describe('FieldSettingsDialog · lookup', () => {
  it('reads a relation, offers only showable target fields and saves the lookup config', async () => {
    await open('new');
    await fillName('Companies');
    await choose(selects()[0]!, 'lookup');
    expect(document.body.textContent).toContain('Shows the chosen field of every linked record');
    const [, relation, target] = selects();
    expect(target!.disabled).toBe(true);
    await choose(relation!, '6');
    expect(api.getTableSchema).toHaveBeenCalledWith(8);
    const choices = [...selects()[2]!.querySelectorAll('option')].map((option) => option.textContent);
    expect(choices).toEqual(['Choose target field', 'Company', 'Spend']);
    await choose(selects()[2]!, '20');
    await save();
    expect(api.createTableField).toHaveBeenCalledWith(7, {
      name: 'Companies',
      type: 'lookup',
      required: false,
      config: { lookup: { relationFieldId: 6, targetFieldId: 20 } },
    });
  });
});
