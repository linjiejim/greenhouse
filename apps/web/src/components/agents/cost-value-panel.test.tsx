/**
 * @vitest-environment happy-dom
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { CostValuePanel } from './cost-value-panel';

const mocks = vi.hoisted(() => ({ fetchCostValueReport: vi.fn() }));

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  fetchCostValueReport: mocks.fetchCostValueReport,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CostValuePanel', () => {
  beforeEach(() => {
    mocks.fetchCostValueReport.mockReset();
    mocks.fetchCostValueReport.mockResolvedValue({
      period: { since: '2026-08-01T00:00:00.000Z', until: '2026-08-12T00:00:00.000Z' },
      accounting: {
        token_cost_estimate: null,
        token_cost_estimate_reason: 'provider_prices_unavailable',
        usd_source: 'usage_budget_ledger',
      },
      organization: {
        total_calls: 4,
        total_input_tokens: 700,
        total_output_tokens: 300,
        total_cached_tokens: 100,
        total_reasoning_tokens: 0,
        total_tokens: 1_000,
        total_duration_ms: 4_000,
        avg_duration_ms: 1_000,
        cost_estimate_usd: null,
        runtime_runs: 1,
        runtime_terminal_runs: 1,
        runtime_succeeded_runs: 1,
        effective_completion_rate: 1,
        actual_usd_micros: 1_250_000,
      },
      agents: [],
      users: [],
      runtime_by_kind: [],
      recent_runs: [],
      budgets: [],
    });
  });

  it('labels tokens as usage and renders dollars only as actual ledger value', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(CostValuePanel),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Token usage');
    expect(container.textContent).toContain('Actual USD ledger');
    expect(container.textContent).toContain('$1.25');
    expect(container.textContent).toContain('Token usage has no dollar estimate');
    expect(container.textContent).not.toContain('Estimated LLM Cost');

    await act(async () => root.unmount());
    container.remove();
  });
});
