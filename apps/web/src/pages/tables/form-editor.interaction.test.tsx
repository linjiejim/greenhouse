/** @vitest-environment happy-dom */

/**
 * The form editor saves only what the builder wrote: an empty success message
 * and the untouched submit label stay empty, so every respondent sees their
 * own language's button and confirmation instead of the builder's.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import type { TableField, TableForm } from '../../lib/api/tables';
import { TablesFormEditor } from './form-editor';

const api = vi.hoisted(() => ({
  createTableForm: vi.fn(),
  updateTableForm: vi.fn(),
  listTableUsers: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T00:00:00.000Z';
const name: TableField = {
  id: 1,
  table_id: 7,
  name: 'Item',
  type: 'text',
  required: true,
  is_primary: true,
  config: '{}',
  position: 0,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  api.listTableUsers.mockResolvedValue([]);
  api.createTableForm.mockImplementation(async (_tableId, input) => ({ id: 4, ...input }) as TableForm);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TablesFormEditor', () => {
  it('leaves the submit label and success message empty unless the builder wrote them', async () => {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="zh">
          <TablesFormEditor tableId={7} fields={[name]} onSaved={vi.fn()} onCancel={vi.fn()} />
        </I18nProvider>,
      );
    });
    expect(container.querySelector<HTMLDetailsElement>('[data-testid="form-presentation"]')?.open).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>('[data-testid="form-defaults"]')?.open).toBe(false);
    await typeInto(container.querySelector('[data-testid="form-name-input"]') as HTMLInputElement, 'Expenses');
    await act(async () => (container.querySelector('[data-testid="form-save"]') as HTMLButtonElement).click());

    expect(api.createTableForm).toHaveBeenCalledTimes(1);
    const config = api.createTableForm.mock.calls[0]![1].config;
    // Not '提交' / the zh confirmation: an English respondent must not get the builder's language.
    expect(config.submitLabel).toBe('');
    expect(config.successMessage).toBe('');
  });

  it('opens configured optional sections and preserves their values when collapsed before saving', async () => {
    const stored = {
      id: 4,
      name: 'Expenses',
      revision: 3,
      audience: { type: 'base' },
      config: {
        version: 1,
        title: 'Expense claim',
        description: 'Travel costs',
        successMessage: 'Thank you',
        fieldIds: [1],
        defaults: [{ fieldId: 2, value: 'Pending' }],
        allowMultiple: false,
      },
    } as TableForm;
    api.updateTableForm.mockResolvedValue(stored);
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <TablesFormEditor
            tableId={7}
            fields={[name, { ...name, id: 2, name: 'Status', is_primary: false, required: false }]}
            form={stored}
            onSaved={vi.fn()}
            onCancel={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    const sections = [...container.querySelectorAll('details')];
    expect(sections).toHaveLength(2);
    expect(sections.every((section) => section.open)).toBe(true);
    await act(async () => {
      for (const section of sections) {
        section.open = false;
        section.dispatchEvent(new Event('toggle'));
      }
    });
    await act(async () => (container.querySelector('[data-testid="form-save"]') as HTMLButtonElement).click());
    expect(api.updateTableForm).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        revision: 3,
        config: expect.objectContaining({
          title: 'Expense claim',
          description: 'Travel costs',
          successMessage: 'Thank you',
          defaults: [{ fieldId: 2, value: 'Pending' }],
          allowMultiple: false,
        }),
      }),
    );
  });
});
