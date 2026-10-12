/** @vitest-environment happy-dom */

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField } from '../../lib/api/tables';
import { I18nProvider } from '../../lib/i18n';
import { AiFieldEditor, AiFieldRuns, emptyAiConfig } from './ai-field-editor';

const api = vi.hoisted(() => ({ getAiFieldStatus: vi.fn(), runAiField: vi.fn() }));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const field: TableField = {
  id: 7,
  table_id: 1,
  name: 'Customer feedback',
  type: 'text',
  required: false,
  is_primary: true,
  config: '{}',
  position: 0,
  created_by: 'u1',
  created_at: '2026-10-12T00:00:00.000Z',
  updated_at: '2026-10-12T00:00:00.000Z',
  archived_at: null,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  api.getAiFieldStatus.mockResolvedValue({
    fieldId: 8,
    counts: { queued: 0, running: 0, failed: 0 },
    usage: { tokens: 50, cap: 10000 },
    records: {},
  });
  api.runAiField.mockResolvedValue({ queued: 2, skipped: 0 });
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

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

describe('AI field setup and generation', () => {
  it('inserts a field by name and selects it as input without duplicating the selection', async () => {
    function Editor() {
      const [config, setConfig] = useState(emptyAiConfig);
      return (
        <>
          <AiFieldEditor value={config} onChange={setConfig} fields={[field]} />
          <output>{JSON.stringify(config)}</output>
        </>
      );
    }
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <Editor />
        </I18nProvider>,
      ),
    );
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Insert a field…"]')!;
    expect(select.textContent).toContain('Customer feedback');
    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        select.value = '7';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    const saved = JSON.parse(container.querySelector('output')!.textContent!);
    expect(saved.prompt).toBe('{{field:7}}{{field:7}}');
    expect(saved.inputFieldIds).toEqual([7]);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });

  it('requires a cost-aware confirmation before regenerating all existing results', async () => {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <AiFieldRuns fieldId={8} />
        </I18nProvider>,
      ),
    );
    await act(async () => button('Regenerate all cells').click());
    expect(api.runAiField).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="confirm-dialog"]')!.textContent).toContain(
      'field creator’s AI budget',
    );
    await act(async () =>
      (document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLButtonElement).click(),
    );
    expect(api.runAiField).not.toHaveBeenCalled();
    await act(async () => button('Regenerate all cells').click());
    await act(async () =>
      (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLButtonElement).click(),
    );
    expect(api.runAiField).toHaveBeenCalledExactlyOnceWith(8, 'regenerate');
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });

  it('fills empty cells directly without adding a confirmation to the non-replacing action', async () => {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <AiFieldRuns fieldId={8} />
        </I18nProvider>,
      ),
    );
    await act(async () => button('Fill empty cells').click());
    expect(api.runAiField).toHaveBeenCalledExactlyOnceWith(8, 'fill');
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
  });
});
