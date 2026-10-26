/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { PluginsPanel } from './plugins';
const fetchStatus = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/plugins', () => ({ fetchPluginStatus: fetchStatus }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | null;
let container: HTMLDivElement;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  vi.useRealTimers();
});
async function render(locale: 'en' | 'zh') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: locale, children: createElement(PluginsPanel) }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}
describe('Administration plugin status', () => {
  it('shows compiled/enabled and lifecycle facts with no mutation controls', async () => {
    fetchStatus.mockResolvedValue([
      {
        id: 'fixture',
        name: 'Fixture plugin',
        compiled: true,
        enabled: false,
        version: '1.2.3',
        sdk: 1,
        migrationState: 'pending',
        bootState: 'disabled',
        bootErrors: [],
        migrationError: null,
        migrations: [],
        dependsOn: [],
      },
    ]);
    await render('en');
    expect(container.textContent).toContain('Fixture plugin');
    expect(container.textContent).toContain('Pending');
    expect(container.textContent).toContain('restart the server');
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.querySelector('[data-testid="admin-plugins-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="admin-plugins-delete"]')).toBeNull();
  });
  it('localizes the empty deployment state', async () => {
    fetchStatus.mockResolvedValue([]);
    await render('zh');
    expect(container.textContent).toContain('此构建未编入任何插件');
    expect(container.textContent).toContain('然后重启服务');
  });
  it('shows a fetch failure instead of claiming there are no plugins', async () => {
    fetchStatus.mockRejectedValue(new Error('Status unavailable'));
    await render('en');
    expect(container.textContent).toContain('Status unavailable');
    expect(container.textContent).not.toContain('No plugins are compiled');
  });
});
