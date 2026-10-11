/** @vitest-environment happy-dom */

/**
 * The Agent profile drawer's Usage and Activity tabs (spec 20261011-agent-first-class P3d): what
 * the Agent spent and did for its owner, never message content.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotActivityItem, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore, useProfileStore } from '../../stores';
import { useBotsStore } from './bots-store';
import { BotProfileDrawer } from './bot-profile-drawer';

const api = vi.hoisted(() => ({
  listBotMemories: vi.fn(),
  listBotVersions: vi.fn(),
  listBotFiles: vi.fn(),
  fetchBotUsage: vi.fn(),
  fetchBotActivity: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAGE: BotView = {
  id: 'bot_sage',
  name: 'Sage',
  role: 'Researcher',
  instructions: '',
  avatar: { color: 'ocean' },
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
  dm_session_id: 'dm-sage',
  last_active_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
};

const ACTIVITY: BotActivityItem[] = [
  {
    at: '2026-10-10T08:00:00.000Z',
    kind: 'vault',
    title: 'fill_login',
    outcome: 'filled',
    detail: 'https://github.com · GitHub (work)',
    session_id: 'chat-1',
  },
  {
    at: '2026-10-11T09:00:00.000Z',
    kind: 'action',
    title: 'projects.updateTask',
    outcome: 'success',
    detail: 'Task #42',
    session_id: 'chat-2',
  },
  {
    at: '2026-10-09T07:00:00.000Z',
    kind: 'task',
    title: 'Weekly digest',
    outcome: 'succeeded',
    detail: null,
    session_id: null,
  },
];

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderDrawer() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(BotProfileDrawer, { onOpenDm: vi.fn() }),
      }),
    ),
  );
  await flush();
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listBotMemories.mockResolvedValue({ memories: [] });
  // Every Agent has at least its first version (an empty history would re-read forever).
  api.listBotVersions.mockResolvedValue({
    bot_id: SAGE.id,
    profile_id: 'bot:bot_sage',
    current_version: 1,
    versions: [{ version: 1, change_log: 'Created', created_at: '2026-10-05T00:00:00.000Z' }],
  });
  api.listBotFiles.mockResolvedValue({ folder: null, docs: [] });
  api.fetchBotUsage.mockResolvedValue({
    days: [
      { day: '2026-10-10', calls: 3, input_tokens: 1200, output_tokens: 300, sessions: 2 },
      { day: '2026-10-09', calls: 0, input_tokens: 0, output_tokens: 0, sessions: 0 },
      { day: '2026-10-11', calls: 1, input_tokens: 500, output_tokens: 100, sessions: 1 },
    ],
    totals: { calls: 4, input_tokens: 1700, output_tokens: 400 },
  });
  api.fetchBotActivity.mockResolvedValue(ACTIVITY);
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } as never });
  useProfileStore.setState({ profiles: [], models: [], fetchProfiles: async () => {}, refresh: async () => {} });
  useBotsStore.getState().reset();
  useBotsStore.setState({ bots: [SAGE], botsLoaded: true, profileBotId: SAGE.id });
  window.location.hash = '#/settings/bots';
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useBotsStore.getState().reset();
});

describe('BotProfileDrawer — usage and activity', () => {
  it('opens on the profile and loads usage only when its tab is chosen', async () => {
    await renderDrawer();
    expect(document.querySelector('[data-testid="bots-profile-tab-profile"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(api.fetchBotUsage).not.toHaveBeenCalled();

    await click(document.querySelector('[data-testid="bots-profile-tab-usage"]'));
    expect(api.fetchBotUsage).toHaveBeenCalledWith(SAGE.id, 30);
    const usage = document.querySelector('[data-testid="bots-profile-usage"]')!;
    expect(usage.textContent).toContain('Calls4');
    expect(usage.textContent).toContain('Input tokens2k');
    expect(usage.textContent).toContain('Output tokens400');
    // Days with work only, newest first.
    const days = [...usage.querySelectorAll('[data-day]')].map((row) => row.getAttribute('data-day'));
    expect(days).toEqual(['2026-10-11', '2026-10-10']);
    expect(usage.querySelector('[data-day="2026-10-10"]')?.textContent).toContain('3 calls · 2k tokens');
    expect(usage.querySelector('[data-day="2026-10-10"]')?.textContent).toContain('2 conversations');
  });

  it('says when there was no model use', async () => {
    api.fetchBotUsage.mockResolvedValue({ days: [], totals: { calls: 0, input_tokens: 0, output_tokens: 0 } });
    await renderDrawer();
    await click(document.querySelector('[data-testid="bots-profile-tab-usage"]'));
    expect(document.body.textContent).toContain('No model use in the last 30 days');
  });

  it('lists what the Agent did, newest first, each with its conversation', async () => {
    await renderDrawer();
    await click(document.querySelector('[data-testid="bots-profile-tab-activity"]'));
    expect(api.fetchBotActivity).toHaveBeenCalledWith(SAGE.id);

    const rows = [...document.querySelectorAll('[data-testid="bots-profile-activity-row"]')];
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['action', 'vault', 'task']);
    expect(rows[0]!.textContent).toContain('projects.updateTask');
    expect(rows[0]!.textContent).toContain('Done');
    expect(rows[0]!.textContent).toContain('Task #42');
    // A vault use reads as the action, with its result.
    expect(rows[1]!.textContent).toContain('Filled sign-in');
    expect(rows[1]!.textContent).toContain('Filled');
    expect(rows[2]!.textContent).toContain('Weekly digest');

    const open = rows[0]!.querySelector<HTMLAnchorElement>('[data-testid="bots-profile-activity-open"]');
    expect(open?.getAttribute('href')).toBe('#/bots?c=chat-2');
    // No conversation, no link.
    expect(rows[2]!.querySelector('[data-testid="bots-profile-activity-open"]')).toBeNull();

    // Following it closes the drawer.
    await click(open);
    expect(useBotsStore.getState().profileBotId).toBeNull();
  });

  it('reads a history that failed to load once, not over and over', async () => {
    api.listBotVersions.mockRejectedValue(new Error('boom'));
    await renderDrawer();
    expect(api.listBotVersions).toHaveBeenCalledTimes(1);
  });

  it('says so when the activity cannot be loaded', async () => {
    api.fetchBotActivity.mockRejectedValue(new Error('boom'));
    await renderDrawer();
    await click(document.querySelector('[data-testid="bots-profile-tab-activity"]'));
    expect(document.body.textContent).toContain("Couldn't load activity");
  });
});
