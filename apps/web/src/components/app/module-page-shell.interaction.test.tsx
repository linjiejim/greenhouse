/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { administrationModules } from '../../lib/nav-registry';
import { MobileModuleTabs } from './module-page-shell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let offsetParentDescriptor: PropertyDescriptor | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
const scrollIntoView = vi.fn();

beforeEach(() => {
  offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  if (offsetParentDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
  }
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

describe('MobileModuleTabs', () => {
  it('marks and brings the current module into view', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(MobileModuleTabs, {
            activeKey: 'users',
            items: administrationModules,
          }),
        }),
      );
    });

    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('Users');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'center' });
  });
});
