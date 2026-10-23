/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchCustomProfiles: vi.fn(async () => []),
  fetchProfiles: vi.fn(async () => []),
  fetchTools: vi.fn(async () => []),
}));
vi.mock('../components/agents/cost-value-panel', () => ({
  CostValuePanel: () => createElement('div', { 'data-testid': 'usage-report' }),
}));

import { I18nProvider } from '../lib/i18n';
import { useAuthStore } from '../stores';
import { AutomationsPage } from './automations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function renderTab(role: 'super' | 'team', locale: 'en' | 'zh' = 'en') {
  useAuthStore.setState({
    currentUser: { id: 'u1', nickname: 'Maya', role } as never,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: locale,
        children: createElement(AutomationsPage, { params: new URLSearchParams('tab=profiles') }),
      }),
    );
  });
  // Let the profile loads settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

beforeEach(() => {
  window.location.hash = '#/automations?tab=profiles';
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useAuthStore.setState({ currentUser: null });
});

describe('Automations › Run profiles', () => {
  it('has one tab row and run-profile copy, with no nested Agents | Usage tab bar', async () => {
    const page = await renderTab('super');
    expect(page.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    const text = page.textContent ?? '';
    expect(text).toContain('Run profiles');
    expect(text).toContain('New run profile');
    expect(text).toContain('No run profiles yet');
    expect(text).not.toMatch(/Create Agent|My Agents|Create your first Agent/);
  });

  it('opens a super’s usage report from the toolbar and comes back', async () => {
    const page = await renderTab('super');
    const usage = [...page.querySelectorAll('button')].find((button) => button.textContent === 'Usage details')!;
    await act(async () => usage.click());
    expect(page.querySelector('[data-testid="usage-report"]')).not.toBeNull();
    expect(page.querySelectorAll('[role="tablist"]')).toHaveLength(1);

    const back = [...page.querySelectorAll('button')].find((button) => button.textContent === 'Back to run profiles')!;
    await act(async () => back.click());
    expect(page.querySelector('[data-testid="usage-report"]')).toBeNull();
  });

  it('offers no usage report to a member, and speaks 执行配置 in Chinese', async () => {
    const page = await renderTab('team', 'zh');
    const text = page.textContent ?? '';
    expect(text).not.toContain('使用详情');
    expect(text).toContain('新建执行配置');
    expect(text).toContain('还没有执行配置');
  });
});
