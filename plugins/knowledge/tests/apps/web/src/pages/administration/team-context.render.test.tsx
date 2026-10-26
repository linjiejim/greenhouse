/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamContextSettingsView } from '@greenhouse/types/hub-context';
import { I18nProvider } from '../../../../../../../../apps/web/src/lib/i18n/index';
import { TeamDocumentPicker as TeamContextPanel } from '../../../../../../../../plugins/knowledge/web/team-context-picker';
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
vi.mock('../../../../../../../../apps/web/src/lib/api/hub-context', () => api);
(
  globalThis as {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;
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
    expect((page.querySelector('[data-testid="team-context-glossary"]') as HTMLSelectElement).value).toBe('terms');
    // Already-picked documents are not offered again.
    const options = [...list.querySelectorAll('option')].map((option) => option.value);
    expect(options).toEqual(['', 'terms', 'handbook']);
    await act(async () => {
      (page.querySelector('button[aria-label="Remove Old rules"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (page.querySelector('[data-testid="team-context-documents-save"]') as HTMLButtonElement).click();
    });
    expect(api.saveTeamContextSettings).toHaveBeenCalledWith({
      conventions: ['how-we-work'],
      glossary: 'terms',
    });
  });
  it('shows a load failure instead of an empty form', async () => {
    api.fetchTeamContextSettings.mockRejectedValue(new Error('Forbidden'));
    const page = await render(createElement(TeamContextPanel));
    await settle(() => page.textContent?.includes('Forbidden') ?? false);
    expect(page.querySelector('[role="alert"]')?.textContent).toBe('Forbidden');
  });
});
