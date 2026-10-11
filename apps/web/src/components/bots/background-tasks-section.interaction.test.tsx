/**
 * @vitest-environment happy-dom
 *
 * The conversations sidebar's "Background" group: every thread's background tasks, live first,
 * then at most three that ended; filtered by the sidebar's search; a row opens the thread that
 * started the task (spec 20261011-agent-first-class §3.1, D15).
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotTaskView, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { useBotsStore } from './bots-store';
import { BackgroundTasksSection } from './background-tasks-section';

const api = vi.hoisted(() => ({ listMemberTasks: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  listMemberTasks: api.listMemberTasks,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bot(id: string, name: string): BotView {
  return {
    id,
    name,
    role: '',
    instructions: '',
    avatar: { plant: 'fern' },
    model_id: null,
    template_key: null,
    status: 'active',
    description: '',
    tools: null,
    connectors: null,
    max_steps: null,
    current_version: 1,
    user_id: 'u1',
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: `dm-${id}`,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

function task(run_id: string, bot_id: string, status: BotTaskView['status'], title: string) {
  return {
    run_id,
    bot_id,
    title,
    status,
    child_session_id: `bottask-${run_id}`,
    summary: null,
    created_at: '2026-10-05T00:00:00.000Z',
    started_at: null,
    ended_at: null,
    session_id: `dm-${bot_id}`,
  };
}

const sage = bot('bot_sage', 'Sage');
const quill = bot('bot_quill', 'Quill');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useBotsStore.setState({ bots: [sage, quill], botsLoaded: true });
  window.location.hash = '#/chat';
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useBotsStore.setState({ ...useBotsStore.getInitialState() });
  window.location.hash = '';
});

async function mount(query = '') {
  await act(async () =>
    root.render(
      createElement(I18nProvider, { initialLocale: 'en', children: createElement(BackgroundTasksSection, { query }) }),
    ),
  );
  await act(async () => {});
}

const rows = () =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="sidebar-background-task"]')].map((el) => el.dataset.runId);

describe('<BackgroundTasksSection/>', () => {
  it('lists live tasks, then at most three that ended, each naming its Agent', async () => {
    api.listMemberTasks.mockResolvedValue({
      tasks: [
        task('r1', sage.id, 'running', 'Check links'),
        task('r2', quill.id, 'waiting', 'Draft the summary'),
        task('r3', sage.id, 'succeeded', 'Old 1'),
        task('r4', sage.id, 'failed', 'Old 2'),
        task('r5', quill.id, 'canceled', 'Old 3'),
        task('r6', quill.id, 'succeeded', 'Old 4'),
      ],
    });
    await mount();
    expect(host.querySelector('[data-testid="sidebar-section-background"]')!.textContent).toBe('Background');
    expect(rows()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(host.textContent).toContain('From Sage');
    expect(host.textContent).toContain('From Quill');
  });

  it("filters with the sidebar's search and opens the thread that started the task", async () => {
    api.listMemberTasks.mockResolvedValue({
      tasks: [task('r1', sage.id, 'running', 'Check links'), task('r2', quill.id, 'running', 'Draft the summary')],
    });
    await mount('quill');
    expect(rows()).toEqual(['r2']);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-run-id="r2"]')!.click());
    expect(window.location.hash).toBe('#/bots?c=dm-bot_quill');
  });

  it('renders nothing when no Agent has background work', async () => {
    api.listMemberTasks.mockResolvedValue({ tasks: [] });
    await mount();
    expect(host.querySelector('[data-testid="sidebar-background-tasks"]')).toBeNull();
  });
});
