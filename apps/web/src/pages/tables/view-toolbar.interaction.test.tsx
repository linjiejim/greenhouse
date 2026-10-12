/** @vitest-environment happy-dom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { TablesViewToolbar } from './view-toolbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.restoreAllMocks();
});

async function mount(rights: { canEdit: boolean; canCreate: boolean; canBuild?: boolean; canDelete?: boolean }) {
  const onImport = vi.fn();
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="en">
        <TablesViewToolbar
          viewControls={null}
          search=""
          filterCount={0}
          canBuild={false}
          pasting={false}
          onSearch={vi.fn()}
          onOpenFilters={vi.fn()}
          onOpenRecycleBin={vi.fn()}
          onOpenForms={vi.fn()}
          onAddField={vi.fn()}
          onAddRecord={vi.fn()}
          onImport={onImport}
          {...rights}
        />
      </I18nProvider>,
    ),
  );
  return onImport;
}

describe('Tables toolbar more actions', () => {
  it('keeps import behind create rights independently from edit rights', async () => {
    await mount({ canEdit: true, canCreate: false });
    await act(async () =>
      (container.querySelector('[data-testid="tables-more-actions"]') as HTMLButtonElement).click(),
    );
    expect(container.querySelector('[data-testid="tables-import-open"]')).toBeNull();
    expect(container.querySelector('[data-testid="tables-recycle-bin"]')).not.toBeNull();
    await act(async () =>
      container
        .querySelector('[role="menuitem"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    const onImport = await mount({ canEdit: false, canCreate: true });
    await act(async () =>
      (container.querySelector('[data-testid="tables-more-actions"]') as HTMLButtonElement).click(),
    );
    expect(container.querySelector('[data-testid="tables-recycle-bin"]')).toBeNull();
    expect(container.querySelector('[data-testid="tables-add-field"]')).toBeNull();
    expect(container.querySelector('[data-testid="tables-manage-forms"]')).toBeNull();
    await act(async () => (container.querySelector('[data-testid="tables-import-open"]') as HTMLButtonElement).click());
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('anchors the keyboard-opened menu to its button and exposes builder actions', async () => {
    await mount({ canEdit: true, canCreate: true, canBuild: true });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="tables-more-actions"]')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 100, bottom: 80 } as DOMRect);
    await act(async () => trigger.click()); // Keyboard activation has no pointer coordinates.
    expect(container.querySelector<HTMLElement>('[role="menu"]')!.style.left).toBe('100px');
    expect(container.querySelector<HTMLElement>('[role="menu"]')!.style.top).toBe('84px');
    expect(document.activeElement).toBe(container.querySelector('[data-testid="tables-import-open"]'));
    expect(container.querySelector('[data-testid="tables-add-field"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tables-manage-forms"]')).not.toBeNull();
  });

  it('omits the more menu for members with no secondary actions', async () => {
    await mount({ canEdit: false, canCreate: false });
    expect(container.querySelector('[data-testid="tables-more-actions"]')).toBeNull();
  });
});
