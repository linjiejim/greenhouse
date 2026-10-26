/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetroResult } from '@greenhouse/types/hub-context';
import { I18nProvider } from './../../../apps/web/src/lib/i18n/index';
import { RetroButton } from './button';
const api = vi.hoisted(() => ({
  fetchTeamContextSettings: vi.fn(),
  saveTeamContextSettings: vi.fn(),
  generateRetro: vi.fn(),
}));
vi.mock('./api', () => ({ generateRetro: api.generateRetro }));
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
