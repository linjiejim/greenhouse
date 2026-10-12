/** @vitest-environment happy-dom */

/**
 * Handing a project task to an Agent from its drawer (spec 20261011-agent-first-class P3e): one of
 * the member's active Agents answers a new task chat; the assignee stays; the task then shows its
 * Agent and the chat.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { ToastContainer } from '../ui';
import { useAuthStore } from '../../stores/auth-store';
import { useBotsStore } from '../bots/bots-store';
import { ProjectsApiError } from '../../lib/api/projects';
import { TaskDetailDrawer } from './task-drawer';
import type { Task } from './types';

const projectsApi = vi.hoisted(() => ({ handTaskToAgent: vi.fn() }));
vi.mock('../../lib/api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/projects')>()),
  ...projectsApi,
}));
vi.mock('../../lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/auth')>()),
  authFetch: vi.fn(async () => new Response(JSON.stringify({ comments: [] }), { status: 200 })),
}));
const botsApi = vi.hoisted(() => ({ listBots: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...botsApi,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function agent(id: string, name: string, templateKey: string | null = null): BotView {
  return {
    id,
    name,
    role: '',
    instructions: '',
    avatar: { color: 'ocean' },
    model_id: null,
    template_key: templateKey,
    status: 'active',
    description: '',
    tools: null,
    connectors: null,
    max_steps: null,
    current_version: 1,
    user_id: 'u1',
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: null,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

const SPROUTY = agent('bot_sprouty', 'Sprouty', 'sprouty');
const SAGE = agent('bot_sage', 'Sage');

const TASK: Task = {
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
};

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderDrawer(task: Task, onUpdate = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: [
          createElement(TaskDetailDrawer, {
            key: 'drawer',
            task,
            open: true,
            onClose: vi.fn(),
            onUpdate,
            users: [{ id: 'u1', nickname: 'Mia' }],
            allTasks: [task],
          }),
          createElement(ToastContainer, { key: 'toasts' }),
        ],
      }),
    ),
  );
  await flush();
  return onUpdate;
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

function signIn(agents: boolean) {
  useAuthStore.setState({
    currentUser: { id: 'u1', role: 'team', nickname: 'Mia', features: { bots: agents } } as never,
  });
}

beforeEach(() => {
  projectsApi.handTaskToAgent.mockReset();
  botsApi.listBots.mockReset();
  useBotsStore.getState().reset();
  useBotsStore.setState({ bots: [SPROUTY, SAGE], botsLoaded: true });
  signIn(true);
  window.location.hash = '#/projects/7';
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useBotsStore.getState().reset();
});

describe('Hand to Agent', () => {
  it('hands the task to the chosen Agent and offers its chat', async () => {
    projectsApi.handTaskToAgent.mockResolvedValue({
      session_id: 'chat-1',
      task: { id: 42, agent_id: SAGE.id, agent_session_id: 'chat-1' },
    });
    const onUpdate = await renderDrawer(TASK);
    expect(document.querySelector('[data-testid="task-agent-row"]')).toBeNull();

    await click(document.querySelector('[data-testid="task-hand-to-agent"]'));
    const dialog = document.querySelector('[data-testid="task-hand-to-agent-dialog"]')!;
    expect(document.body.textContent).toContain('Hand “Draft the launch plan” to an Agent');
    expect(dialog.textContent).toContain('The assignee stays the same');
    const pick = dialog.querySelector<HTMLSelectElement>('[data-testid="task-agent-pick"]')!;
    expect([...pick.options].map((option) => option.textContent)).toEqual(['Sprouty', 'Sage']);
    await act(async () => {
      pick.value = SAGE.id;
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(dialog.querySelector('[data-testid="task-agent-start"]'));

    expect(projectsApi.handTaskToAgent).toHaveBeenCalledWith(42, SAGE.id);
    expect(onUpdate).toHaveBeenCalled();
    expect(document.querySelector('[data-testid="task-hand-to-agent-dialog"]')).toBeNull();
    expect(document.body.textContent).toContain('Sage is on it');
    const openChat = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open chat');
    await click(openChat);
    expect(window.location.hash).toBe('#/bots?c=chat-1');
  });

  it('shows the Agent working on it, with its chat', async () => {
    await renderDrawer({ ...TASK, agent_id: SAGE.id, agent_session_id: 'chat-1' });
    const row = document.querySelector('[data-testid="task-agent-row"]')!;
    expect(row.textContent).toContain('Sage');
    expect(row.querySelector('[data-testid="task-agent-open-chat"]')?.getAttribute('href')).toBe('#/bots?c=chat-1');
    // The assignee is still the person responsible.
    expect(document.body.textContent).toContain('Mia');
  });

  it('names another member’s Agent without a chat it could not open', async () => {
    await renderDrawer({ ...TASK, agent_id: 'bot_theirs', agent_session_id: 'chat-9' });
    const row = document.querySelector('[data-testid="task-agent-row"]')!;
    expect(row.textContent).toContain("Another member's Agent");
    expect(row.querySelector('[data-testid="task-agent-open-chat"]')).toBeNull();
  });

  it('explains a refusal', async () => {
    projectsApi.handTaskToAgent.mockRejectedValue(new ProjectsApiError('Agent not found', 404));
    await renderDrawer(TASK);
    await click(document.querySelector('[data-testid="task-hand-to-agent"]'));
    await click(document.querySelector('[data-testid="task-agent-start"]'));
    expect(projectsApi.handTaskToAgent).toHaveBeenCalledWith(42, SPROUTY.id);
    expect(document.body.textContent).toContain('That Agent or this task is no longer available to you.');
  });

  it('offers nothing when Agents are off for the member', async () => {
    signIn(false);
    await renderDrawer({ ...TASK, agent_id: SAGE.id, agent_session_id: 'chat-1' });
    expect(document.querySelector('[data-testid="task-hand-to-agent"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-agent-row"]')).toBeNull();
  });
});
