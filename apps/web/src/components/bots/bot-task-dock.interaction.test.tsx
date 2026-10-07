/**
 * @vitest-environment happy-dom
 *
 * Task Dock rows name the Bot that owns each task and show how the task went as
 * that Bot's pose — failed looks failed, finished looks done — and never loop:
 * the dock is a list, and in the Bots surface motion means "this one is talking".
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotTaskView, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotTaskDock } from './bot-task-dock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAGE: BotView = {
  id: 'bot_sage',
  name: 'Sage',
  role: 'Researcher',
  instructions: '',
  avatar: { plant: 'sage' },
  model_id: null,
  template_key: null,
  status: 'active',
  description: '',
  tools: null,
  max_steps: null,
  current_version: 1,
  user_id: 'u1',
  updated_at: '2026-10-05T00:00:00.000Z',
  dm_session_id: 'dm-sage',
  last_active_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
};

function task(status: BotTaskView['status']): BotTaskView {
  return {
    run_id: `run_${status}`,
    bot_id: SAGE.id,
    title: `Task ${status}`,
    status,
    child_session_id: null,
    summary: null,
    created_at: '2026-10-05T00:00:00.000Z',
    started_at: '2026-10-05T00:00:00.000Z',
    ended_at: null,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The dock row remembers whether it was open; open it so the task list renders.
  localStorage.setItem('task-dock-open:bot-tasks', '1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

function mount(tasks: BotTaskView[]) {
  act(() =>
    root.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(BotTaskDock, {
          tasks,
          lookup: (key: string | null | undefined) => (key === SAGE.id ? SAGE : undefined),
          onChanged: vi.fn(),
        }),
      }),
    ),
  );
}

/** The owning Bot's avatar on the row of the task with this status. */
function avatarOf(status: BotTaskView['status']) {
  const row = [...host.querySelectorAll('[data-testid="bots-task-dock"] li')].find((li) =>
    li.textContent?.includes(`Task ${status}`),
  );
  if (!row) throw new Error(`no row for ${status}`);
  return row.querySelector<HTMLElement>('.pa-root')!;
}

describe('<BotTaskDock/> rows', () => {
  it("pose the owning Bot by the task's status, statically", () => {
    const expected: Record<BotTaskView['status'], string> = {
      queued: 'idle',
      running: 'idle',
      waiting: 'waiting',
      succeeded: 'done',
      failed: 'error',
      canceled: 'sleep',
      interrupted: 'error',
    };
    // Finished tasks only stay in the dock while another one is still running.
    mount((Object.keys(expected) as BotTaskView['status'][]).map(task));

    for (const [status, pose] of Object.entries(expected)) {
      const svg = avatarOf(status as BotTaskView['status']).querySelector('svg')!;
      expect(svg.getAttribute('class'), status).toContain(`pa-s-${pose}`);
    }
    // waiting / done / error are live states that animate by default — not in a list.
    expect(host.querySelectorAll('[data-testid="bots-task-dock"] .pa-mo')).toHaveLength(0);
  });

  it('names the Bot, since the row prints the task and not whose it is', () => {
    mount([task('running')]);
    const avatar = avatarOf('running');
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('Sage');
    expect(avatar.hasAttribute('aria-hidden')).toBe(false);
  });
});
