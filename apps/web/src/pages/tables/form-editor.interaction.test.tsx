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
    await typeInto(container.querySelector('[data-testid="form-name-input"]') as HTMLInputElement, 'Expenses');
    await act(async () => (container.querySelector('[data-testid="form-save"]') as HTMLButtonElement).click());

    expect(api.createTableForm).toHaveBeenCalledTimes(1);
    const config = api.createTableForm.mock.calls[0]![1].config;
    // Not '提交' / the zh confirmation: an English respondent must not get the builder's language.
    expect(config.submitLabel).toBe('');
    expect(config.successMessage).toBe('');
  });
});
