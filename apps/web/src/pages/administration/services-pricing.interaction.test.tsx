/** @vitest-environment happy-dom */

/**
 * Services & pricing: the member-limit list pages through its rows and is
 * re-read when the month changes; the budget table's header columns keep the
 * cells' spacing; the unpriced banner shows while anything in use is unpriced.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetView, MeteringOverview } from '@greenhouse/types/metering';

function budget(scope: BudgetView['scope'], scopeId: string, label: string | null = null): BudgetView {
  return {
    scope,
    scope_id: scopeId,
    label,
    limit_usd_micros: 50_000_000,
    source: 'default',
    spent_usd_micros: 1_000_000,
    reserved_usd_micros: 0,
  };
}

function overview(memberCount: number, prefix: string, unpricedModels: string[] = []): MeteringOverview {
  return {
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    services: [],
    models: [{ id: 'flash', name: 'Default model', configured: true, price: null, source: null }],
    unpriced_in_use: { models: unpricedModels, services: [] },
    spend: {
      totals: { cost_usd_micros: 0, calls: 0, unpriced_calls: 0 },
      by_member: [],
      by_service: [],
      by_client: [],
      by_agent_client: [],
      unsettled_usd_micros: 0,
    },
    budgets: {
      organization: budget('organization', ''),
      member_default: budget('member_default', ''),
      services: [budget('service', 'llm')],
      members: Array.from({ length: memberCount }, (_, i) =>
        budget('member', `u${i}`, `${prefix} ${String(i).padStart(2, '0')}`),
      ),
    },
  };
}

const api = vi.hoisted(() => ({ fetchMeteringOverview: vi.fn() }));
vi.mock('../../lib/api/metering', () => ({
  fetchMeteringOverview: api.fetchMeteringOverview,
  saveBudgetLimit: vi.fn(),
  resetBudgetLimit: vi.fn(),
  savePriceOverride: vi.fn(),
  resetPriceOverride: vi.fn(),
}));

import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { ServicesPricingPanel } from './services-pricing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  api.fetchMeteringOverview.mockReset();
  useAuthStore.setState({ currentUser: null });
});

async function until(check: () => boolean) {
  for (let i = 0; i < 40 && !check(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function render() {
  useAuthStore.setState({ currentUser: { id: 'admin', nickname: 'Ada', role: 'super' } as never });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(ServicesPricingPanel) }));
  });
  await until(() => Boolean(container?.querySelector('[role="tab"]')));
}

async function openBudgets() {
  const tab = [...(container?.querySelectorAll('[role="tab"]') ?? [])].find((el) => el.textContent === 'Budgets');
  await act(async () => (tab as HTMLButtonElement).click());
}

describe('Services & pricing', () => {
  it('pages member limits, keeps the full count, and re-reads them for another month', async () => {
    api.fetchMeteringOverview.mockImplementation(async (month?: string) =>
      overview(60, month && month !== api.fetchMeteringOverview.mock.calls[0]?.[0] ? 'Earlier' : 'Member'),
    );
    await render();
    await openBudgets();
    await until(() => Boolean(container?.textContent?.includes('Member 00')));

    // Page size 50: the 51st member is on page two.
    expect(container?.textContent).toContain('Member 49');
    expect(container?.textContent).not.toContain('Member 50');
    expect(container?.textContent).toContain('60');

    const select = container?.querySelector('[data-testid="metering-month"]') as HTMLSelectElement;
    const previous = select.options[1]!.value;
    await act(async () => {
      select.value = previous;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => Boolean(container?.textContent?.includes('Earlier 00')));
    expect(api.fetchMeteringOverview).toHaveBeenCalledWith(previous);
    expect(container?.textContent).not.toContain('Member 00');
  });

  it('pads the budget headers like their cells, so Reserved and Used stay apart', async () => {
    api.fetchMeteringOverview.mockResolvedValue(overview(1, 'Member'));
    await render();
    await openBudgets();
    await until(() => Boolean(container?.querySelector('[data-testid="metering-budgets"]')));
    const headers = [...(container?.querySelectorAll('[data-testid="metering-budgets"] th') ?? [])];
    const reserved = headers.find((th) => th.textContent === 'Reserved')!;
    const used = headers.find((th) => th.textContent === 'Used')!;
    expect(reserved.className).toContain('pr-3');
    expect(used.className).toContain('pl-3');
  });

  it('warns while a model in use is unpriced', async () => {
    api.fetchMeteringOverview.mockResolvedValue(overview(0, 'Member', ['flash']));
    await render();
    await until(() => Boolean(container?.querySelector('[data-testid="metering-unpriced-banner"]')));
    const banner = container?.querySelector('[data-testid="metering-unpriced-banner"]');
    expect(banner?.textContent).toContain('1 models / services in use are unpriced');
    expect(banner?.textContent).toContain('Default model');
  });
});
