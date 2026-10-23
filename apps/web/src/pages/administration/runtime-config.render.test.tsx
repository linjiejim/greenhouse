/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSettingView } from '@greenhouse/types';
import { I18nProvider } from '../../lib/i18n';
import { RuntimeConfigPanel } from './runtime-config';

// GATEWAY_ENABLED=true in the environment, nothing stored.
const gateway: WorkspaceSettingView = {
  key: 'gateway.enabled',
  group: 'gateway',
  label: 'Model gateway',
  description: 'switch',
  type: 'boolean',
  secret: false,
  env: 'GATEWAY_ENABLED',
  value: null,
  has_value: false,
  source: 'env',
  flag: { effective: true, fallback: true },
};

const saveWorkspaceSettings = vi.fn(async (_values: Record<string, unknown>) => [gateway]);

vi.mock('../../lib/api/workspace-settings', () => ({
  fetchWorkspaceSettings: async () => [gateway],
  saveWorkspaceSettings: (values: Record<string, unknown>) => saveWorkspaceSettings(values),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = container = null;
});

describe('Runtime Config boolean switches', () => {
  it('shows an env-enabled switch as On and lets it be switched off', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(RuntimeConfigPanel) }));
    });
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.parentElement?.textContent).toContain('On');

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Save'))!;
    await act(async () => save.click());
    expect(saveWorkspaceSettings).toHaveBeenCalledWith({ 'gateway.enabled': false });
  });
});
