/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { SidebarAccountMenu } from './user-menu';
import { applyTheme } from '../../lib/theme';
import { useDesktopUpdateStore } from '../../stores/desktop-update-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  applyTheme('system');
  useDesktopUpdateStore.getState().setReleaseNotesOpen(false);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SidebarAccountMenu destinations', () => {
  it('places Execution Center immediately below Inbox, then Release notes, in the account flyout', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(SidebarAccountMenu, {
            user: { id: 'u1', email: 'test@example.com', nickname: 'Test', role: 'team' },
          }),
        }),
      );
    });

    await act(async () => {
      container?.firstElementChild?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const items = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.slice(0, 3).map((item) => item.textContent?.trim())).toEqual([
      'Inbox',
      'Execution Center',
      'Release notes',
    ]);
    expect(items[1]?.getAttribute('href')).toBe('#/executions');

    // Release notes open the web-owned dialog in a browser too — they are not
    // gated on the desktop shell, unlike "Check for updates".
    await act(async () => items[2]?.click());
    expect(useDesktopUpdateStore.getState().releaseNotesOpen).toBe(true);
    expect(items.some((item) => item.textContent?.trim() === 'Check for updates')).toBe(false);
  });

  it('switches between system, dark, and light without leaving the account flyout', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(SidebarAccountMenu, {
            user: { id: 'u1', email: 'test@example.com', nickname: 'Test', role: 'team' },
          }),
        }),
      );
    });
    await act(async () => {
      container?.firstElementChild?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual(['Follow System', 'Dark', 'Light']);
    expect(options.map((option) => option.textContent?.trim())).toEqual(['', '', '']);

    await act(async () => options[1]?.click());
    expect(document.documentElement.dataset.themePreference).toBe('dark');
    expect(options[1]?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => options[2]?.click());
    expect(document.documentElement.dataset.themePreference).toBe('light');
    expect(options[2]?.getAttribute('aria-checked')).toBe('true');
  });
});
