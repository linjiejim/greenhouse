/** @vitest-environment happy-dom */

/**
 * The widget editor refuses what the contract would refuse in the builder's
 * own words (never the contract's `aggregate.limit …` text), and shows the
 * error next to Save — the dialog scrolls, so an error at the top is unseen.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n';
import type { TableDefinition, TableField } from '../../../lib/api/tables';
import { WidgetDialog } from './widget-dialog';

const api = vi.hoisted(() => ({
  createTableDashboardWidget: vi.fn(),
  updateTableDashboardWidget: vi.fn(),
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
const stage: TableField = {
  id: 2,
  table_id: 7,
  name: 'Stage',
  type: 'single_select',
  required: false,
  is_primary: false,
  config: JSON.stringify({ options: [{ id: 'won', label: 'Won' }] }),
  position: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
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

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function labelled<T extends Element>(label: string): T {
  const field = [...document.querySelectorAll('label')].find((entry) => entry.textContent?.trim() === label);
  const id = field?.getAttribute('for');
  const control = id ? document.getElementById(id) : null;
  if (!control) throw new Error(`no control "${label}"`);
  return control as unknown as T;
}

async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

describe('WidgetDialog', () => {
  it('asks for a numeric field only when the calculation uses one, preserving the previous choice', async () => {
    const amount = { ...stage, id: 3, type: 'number' as const, name: 'Amount', config: '{}' };
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <WidgetDialog
            open
            dashboardId={11}
            editing={null}
            tables={[table]}
            users={[]}
            loadFields={async () => [stage, amount]}
            onClose={vi.fn()}
            onSaved={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    await flush();
    expect([...document.querySelectorAll('label')].some((label) => label.textContent === 'Value field')).toBe(false);
    await setValue(labelled<HTMLSelectElement>('Calculation'), 'sum');
    await setValue(labelled<HTMLSelectElement>('Value field'), '3');
    await setValue(labelled<HTMLSelectElement>('Calculation'), 'count');
    expect([...document.querySelectorAll('label')].some((label) => label.textContent === 'Value field')).toBe(false);
    await setValue(labelled<HTMLSelectElement>('Calculation'), 'sum');
    expect(labelled<HTMLSelectElement>('Value field').value).toBe('3');
  });

  it('says a typed limit outside 1–100 in words, next to Save, and saves nothing', async () => {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WidgetDialog
            open
            dashboardId={11}
            editing={null}
            tables={[table]}
            users={[]}
            loadFields={async () => [stage]}
            onClose={vi.fn()}
            onSaved={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();
    await setValue(labelled<HTMLInputElement>('Title'), 'By stage');
    await setValue(labelled<HTMLSelectElement>('Widget type'), 'chart');
    await setValue(labelled<HTMLSelectElement>('Group by'), `f:${stage.id}`);
    await setValue(labelled<HTMLInputElement>('Show at most'), '500');
    const save = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add dashboard widget',
    )!;
    await act(async () => save.click());

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('“Show at most” must be a whole number from 1 to 100.');
    expect(alert?.textContent).not.toContain('aggregate.limit');
    // Rendered right before the actions, not at the top of the scrolling dialog.
    expect(alert?.nextElementSibling?.contains(save)).toBe(true);
    expect(api.createTableDashboardWidget).not.toHaveBeenCalled();
  });
});
