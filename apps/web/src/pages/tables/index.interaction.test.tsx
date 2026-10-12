/** @vitest-environment happy-dom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import type { TableBaseWithRole } from '../../lib/api/tables';
import { TablesPage } from './index';

const api = vi.hoisted(() => ({ listTableBases: vi.fn() }));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));
vi.mock('./base-workspace', () => ({ BaseWorkspace: () => null }));
vi.mock('../../components/tables/base-dialog', () => ({ BaseDialog: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Tables overview search', () => {
  it('keeps the latest search results when an older request finishes later', async () => {
    let resolveOld!: (rows: TableBaseWithRole[]) => void;
    let resolveLatest!: (rows: TableBaseWithRole[]) => void;
    api.listTableBases.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    api.listTableBases.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLatest = resolve;
        }),
    );
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <TablesPage />
        </I18nProvider>,
      ),
    );
    await act(async () => vi.advanceTimersByTime(180));
    const search = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Latest');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(180));
    const base = {
      id: 1,
      name: 'Latest base',
      role: 'owner',
      visibility: 'private',
      updated_at: '2026-10-12T00:00:00.000Z',
    } as TableBaseWithRole;
    await act(async () => resolveLatest([base]));
    expect(container.textContent).toContain('Latest base');
    await act(async () => resolveOld([{ ...base, id: 2, name: 'Older unrelated base' }]));
    expect(container.textContent).toContain('Latest base');
    expect(container.textContent).not.toContain('Older unrelated base');
  });
});
