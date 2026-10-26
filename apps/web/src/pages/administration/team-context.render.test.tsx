/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ fetchTeamContextSettings: vi.fn(), saveTeamContextSettings: vi.fn() }));
vi.mock('../../lib/api/hub-context', () => api);
vi.mock('../../extensions/index', () => ({ extensionSlots: () => [] }));
vi.mock('../../components/app/module-page', () => ({ ModulePage: ({ children }: { children: unknown }) => children }));
import { TeamContextPanel } from './team-context';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('edits Markdown without writing the document selection owned by an optional source', async () => {
  const view = {
    conventions: [],
    glossary: null,
    candidates: [],
    timezone: null,
    effective_timezone: 'Asia/Shanghai',
    retro_next_run_at: null,
    document_source: false,
    markdown: { overview: 'Our team', conventions: 'Review changes', glossary: 'Station: server' },
  };
  api.fetchTeamContextSettings.mockResolvedValue(view);
  api.saveTeamContextSettings.mockResolvedValue(view);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(TeamContextPanel));
    });
    expect(container.querySelectorAll('textarea')).toHaveLength(3);
    expect(container.querySelector('[data-testid="team-context-conventions"]')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="team-context-save"]') as HTMLButtonElement).click();
    });
    expect(api.saveTeamContextSettings).toHaveBeenCalledWith({ markdown: view.markdown, timezone: null });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
