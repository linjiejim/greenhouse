/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { ToolCallRenderer } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  useAuthStore.getState().setCurrentUser(null);
  container?.remove();
  root = null;
  container = null;
});

describe('workflow tool visibility', () => {
  it('hides workflow traces from team users and reveals them to super users', async () => {
    useAuthStore.getState().setCurrentUser({
      id: 'team-1',
      email: 'team@example.com',
      nickname: 'Team',
      role: 'team',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(ToolCallRenderer, {
            calls: [{ name: 'workflow_plan', input: {}, output: { error: 'invalid draft' } }],
            variant: 'full',
          }),
        }),
      );
    });
    expect(container.textContent).toBe('');

    await act(async () => {
      useAuthStore.getState().setCurrentUser({
        id: 'super-1',
        email: 'super@example.com',
        nickname: 'Super',
        role: 'super',
      });
    });
    expect(container.textContent).toContain('Tool calls');
  });
});
