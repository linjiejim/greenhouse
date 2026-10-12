/** @vitest-environment happy-dom */

/**
 * `#/projects/<id>?task=<taskId>` — the link an Agent's task chat starts from — opens that task's
 * drawer once the project has loaded; the hand-off shows in the project's activity.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { useAuthStore } from '../stores/auth-store';
import { ProjectDetailPage } from './project-detail';

vi.mock('../components/agent-context', () => ({ useAgentContext: () => ({ enrichPageContext: () => {} }) }));

const TASK = {
  id: 42,
  project_id: 7,
  parent_id: null,
  title: 'Draft the launch plan',
  description: null,
  status: 'todo',
  priority: 'normal',
  task_type: 'task',
  assignee_id: 'u1',
  assignee_nickname: 'Mia',
  start_date: null,
  due_date: null,
  completed_at: null,
  sort_order: 0,
  estimated_hours: null,
  tags: [],
  dependencies: [],
  created_by: 'u1',
  created_at: '2026-10-05T00:00:00.000Z',
  updated_at: '2026-10-05T00:00:00.000Z',
  agent_id: null,
  agent_session_id: null,
  children: [],
};

const routes: Record<string, unknown> = {
  '/api/projects/7': {
    project: {
      id: 7,
      title: 'Launch',
      description: null,
      status: 'active',
      priority: 'normal',
      owner_id: 'u1',
      owner_nickname: 'Mia',
      start_date: null,
      end_date: null,
    },
    tasks: [TASK],
    stats: { total: 1, done: 0 },
    progress: 0,
    members: [],
  },
  '/api/projects/meta/users': { users: [{ id: 'u1', nickname: 'Mia' }] },
  '/api/projects/tasks/42/comments': { comments: [] },
  '/api/projects/7/activities?limit=30': {
    activities: [
      {
        id: 1,
        action: 'task_handed_to_agent',
        detail: 'Sage',
        user_id: 'u1',
        user_nickname: 'Mia',
        created_at: '2026-10-11T09:00:00.000Z',
      },
    ],
  },
};

vi.mock('../lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/auth')>()),
  authFetch: vi.fn(async (url: string) =>
    url in routes
      ? new Response(JSON.stringify(routes[url]), { status: 200 })
      : new Response(JSON.stringify({ error: 'nope' }), { status: 404 }),
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
const width = window.innerWidth;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage(initialTaskId?: number) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ProjectDetailPage, { projectId: 7, initialTaskId }),
      }),
    ),
  );
  await flush();
}

beforeEach(() => {
  // The list view (the Gantt chart is the desktop default).
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia', features: {} } as never });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
});

describe('ProjectDetailPage — a task link', () => {
  it('opens the linked task’s drawer', async () => {
    await renderPage(42);
    expect(document.querySelector('[aria-label="Task: Draft the launch plan"]')).not.toBeNull();
  });

  it('opens no drawer without one', async () => {
    await renderPage();
    expect(document.body.textContent).toContain('Draft the launch plan');
    expect(document.querySelector('[aria-label="Task: Draft the launch plan"]')).toBeNull();
  });

  it('words a hand-off to an Agent in the activity', async () => {
    await renderPage();
    const changelog = document.querySelector('button[title="Changelog"]');
    if (!changelog) throw new Error(`No changelog button in: ${document.body.textContent}`);
    await act(async () => changelog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(document.body.textContent).toContain('Handed to Agent Sage');
  });
});
