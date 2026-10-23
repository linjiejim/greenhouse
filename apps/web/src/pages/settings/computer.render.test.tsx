/** @vitest-environment happy-dom */

/**
 * Settings › Cloud computer: explains itself while the workspace switch is off
 * (no start button at all), and shows the member's running computer with its
 * minutes and a stop action once it is on.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyComputerReport } from '@greenhouse/types/metering';

const api = vi.hoisted(() => ({ fetchMyComputer: vi.fn(), startMyComputer: vi.fn(), stopMyComputer: vi.fn() }));
vi.mock('../../lib/api/computer', () => api);

import { I18nProvider } from '../../lib/i18n';
import { ComputerPanel } from './computer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function report(over: Partial<MyComputerReport> = {}): MyComputerReport {
  return {
    enabled: true,
    configured: true,
    price_per_minute_usd: 0.0018,
    idle_minutes: 15,
    computer: null,
    minutes_this_month: 42,
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    ...over,
  };
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(ComputerPanel) }));
  });
  for (let i = 0; i < 40 && api.fetchMyComputer.mock.calls.length === 0; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const buttons = () => [...(container?.querySelectorAll('button') ?? [])].map((button) => button.textContent);

describe('Settings › Cloud computer', () => {
  it('only explains itself while the switch is off', async () => {
    api.fetchMyComputer.mockResolvedValue(report({ enabled: false }));
    await render();
    expect(container?.textContent).toContain('The cloud computer is off');
    expect(buttons()).not.toContain('Start');
  });

  it('shows the running computer, its minutes and a stop action', async () => {
    api.fetchMyComputer.mockResolvedValue(
      report({
        computer: {
          id: 'cmp_1',
          status: 'running',
          started_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
          stopped_at: null,
          stop_reason: null,
          minutes_billed: 0,
          client: 'mcp',
        },
      }),
    );
    await render();
    const status = container?.querySelector('[data-testid="computer-status"]');
    expect(status?.textContent).toContain('Running');
    expect(status?.textContent).toContain('42');
    expect(buttons()).toContain('Stop');
    expect(container?.querySelector('[data-testid="computer-files-lost"]')?.textContent).toContain('computer_transfer');

    api.stopMyComputer.mockResolvedValue(undefined);
    const stop = [...(container?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Stop');
    await act(async () => (stop as HTMLButtonElement).click());
    expect(api.stopMyComputer).toHaveBeenCalledTimes(1);
  });
});
