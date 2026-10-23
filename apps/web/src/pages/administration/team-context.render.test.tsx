/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetroResult, TeamContextSettingsView } from '@greenhouse/types/hub-context';
import { I18nProvider } from '../../lib/i18n';
import { TeamContextPanel } from './team-context';
import { RetroButton } from './retro-button';

const view: TeamContextSettingsView = {
  conventions: [
    { doc_id: 'how-we-work', title: 'How we work', problem: null },
    { doc_id: 'old-rules', title: 'Old rules', problem: 'not_team' },
  ],
  glossary: { doc_id: 'terms', title: 'Terms', problem: null },
  timezone: null,
  effective_timezone: 'Asia/Shanghai',
  candidates: [
    { doc_id: 'how-we-work', title: 'How we work' },
    { doc_id: 'terms', title: 'Terms' },
    { doc_id: 'handbook', title: 'Handbook' },
  ],
  retro_next_run_at: '2026-11-01T01:00:00.000Z',
};

const api = vi.hoisted(() => ({
  fetchTeamContextSettings: vi.fn(),
  saveTeamContextSettings: vi.fn(),
  generateRetro: vi.fn(),
}));

vi.mock('../../lib/api/hub-context', () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReturnType<typeof createElement>) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: node }));
  });
  return container;
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 30 && !until(); i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('Administration › Team context', () => {
  it('lists the picks, flags one that stopped serving, and saves the selection', async () => {
    api.fetchTeamContextSettings.mockResolvedValue(view);
    api.saveTeamContextSettings.mockImplementation(async (input) => ({
      ...view,
      conventions: input.conventions.map((id: string) => ({ doc_id: id, title: id, problem: null })),
    }));
    const page = await render(createElement(TeamContextPanel));
    await settle(() => page.textContent?.includes('How we work') ?? false);

    const list = page.querySelector('[data-testid="team-context-conventions"]')!;
    expect(list.textContent).toContain('How we work');
    expect(list.textContent).toContain('Not team-visible');
    expect(page.textContent).toContain('In effect: Asia/Shanghai');
    expect(page.textContent).toContain('Next retro:');
    expect((page.querySelector('[data-testid="team-context-glossary"]') as HTMLSelectElement).value).toBe('terms');
    // Already-picked documents are not offered again.
    const options = [...list.querySelectorAll('option')].map((option) => option.value);
    expect(options).toEqual(['', 'terms', 'handbook']);

    await act(async () => {
      (page.querySelector('button[aria-label="Remove Old rules"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (page.querySelector('[data-testid="team-context-save"]') as HTMLButtonElement).click();
    });
    expect(api.saveTeamContextSettings).toHaveBeenCalledWith({
      conventions: ['how-we-work'],
      glossary: 'terms',
      timezone: null,
    });
  });

  it('shows a load failure instead of an empty form', async () => {
    api.fetchTeamContextSettings.mockRejectedValue(new Error('Forbidden'));
    const page = await render(createElement(TeamContextPanel));
    await settle(() => page.textContent?.includes('Forbidden') ?? false);
    expect(page.querySelector('[role="alert"]')?.textContent).toBe('Forbidden');
  });
});

describe('Issues & requests › Generate this month’s retro', () => {
  it('writes the retro and links to it', async () => {
    const result: RetroResult = {
      month: '2026-10',
      doc_id: 'team-retro-2026-10',
      url: '#/knowledge/doc/7-team-retro-2026-10',
      created: true,
      suggestions: 'skipped',
      skipped_reason: 'over_budget',
    };
    api.generateRetro.mockResolvedValue(result);
    const page = await render(createElement(RetroButton));
    expect(page.textContent).toContain('Generate this month’s retro');
    await act(async () => {
      (page.querySelector('[data-testid="retro-generate"]') as HTMLButtonElement).click();
    });
    await settle(() => page.querySelector('[data-testid="retro-open"]') !== null);
    expect(api.generateRetro).toHaveBeenCalledWith();
    const link = page.querySelector('[data-testid="retro-open"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(result.url);
    expect(link.textContent).toContain('Open 2026-10 retro');
  });
});
