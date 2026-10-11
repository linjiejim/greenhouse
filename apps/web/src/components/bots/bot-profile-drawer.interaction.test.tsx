/** @vitest-environment happy-dom */

/**
 * The Agent profile drawer's Usage and Activity tabs (spec 20261011-agent-first-class P3d): what
 * the Agent spent and did for its owner, never message content. Publish and Ratings (P4): the
 * owner's publication and the ratings its users gave — never for the main Agent; someone else's
 * public Agent opens its public face only.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotActivityItem, BotPublicationView, BotView, SharedBotView } from '@greenhouse/types/bots';
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
  fetchBotPublication: vi.fn(),
  updateBotPublication: vi.fn(),
  fetchBotFeedback: vi.fn(),
  openPublicAgent: vi.fn(),
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

const PUBLICATION: BotPublicationView = {
  visibility: 'public',
  published_version: 1,
  current_version: 2,
  paused: false,
  users: 3,
  audience: { everyone: false, user_ids: ['u2', 'u3'], group_ids: [7] },
  grants: { kb_folder_ids: [11], computer: true },
  budget: { monthly_tokens: null, daily_tokens_per_user: 50_000 },
};

describe('BotProfileDrawer — publishing and ratings (P4)', () => {
  it('never offers publishing for the main Agent', async () => {
    useBotsStore.setState({ bots: [{ ...SAGE, template_key: 'sprouty' }] });
    await renderDrawer();
    expect(document.querySelector('[data-testid="bots-profile-tab-publish"]')).toBeNull();
    expect(document.querySelector('[data-testid="bots-profile-tab-feedback"]')).toBeNull();
  });

  it('shows the publication and publishes the current version', async () => {
    useBotsStore.setState({ bots: [{ ...SAGE, current_version: 2, visibility: 'public', published_version: 1 }] });
    api.listBotVersions.mockResolvedValue({
      bot_id: SAGE.id,
      profile_id: 'bot:bot_sage',
      current_version: 2,
      versions: [{ version: 2, change_log: 'Edited', created_at: '2026-10-06T00:00:00.000Z' }],
    });
    api.fetchBotPublication.mockResolvedValue(PUBLICATION);
    api.updateBotPublication.mockResolvedValue({ ...PUBLICATION, published_version: 2 });
    await renderDrawer();
    // A published Agent says so in its header.
    expect(document.querySelector('[data-testid="bots-profile-public"]')?.textContent).toBe('Public · v1');
    expect(api.fetchBotPublication).not.toHaveBeenCalled();

    await click(document.querySelector('[data-testid="bots-profile-tab-publish"]'));
    expect(api.fetchBotPublication).toHaveBeenCalledWith(SAGE.id);
    const panel = document.querySelector('[data-testid="bots-profile-publish"]')!;
    expect(panel.textContent).toContain('Published v1 · current v2');
    expect(panel.textContent).toContain('not live yet');
    expect(panel.textContent).toContain('3 people have a conversation with it');
    expect(document.querySelector('[data-testid="bots-publish-audience"]')?.textContent).toBe('2 people · 1 groups');
    expect(panel.textContent).toContain('1 knowledge folders, read-only');
    expect(panel.textContent).toContain('Its own computer');
    expect(panel.textContent).toContain('2.0M tokens a month (default)');
    expect(panel.textContent).toContain('Up to 50k tokens per person a day');

    await click(document.querySelector('[data-testid="bots-publish-current"]'));
    expect(api.updateBotPublication).toHaveBeenCalledWith(SAGE.id, { publish: true });
    expect(document.querySelector('[data-testid="bots-publish-versions"]')?.textContent).toBe(
      'Published v2 · current v2',
    );
    // The lists badge the newly published version.
    expect(useBotsStore.getState().bots[0]?.published_version).toBe(2);
    expect(document.querySelector<HTMLButtonElement>('[data-testid="bots-publish-current"]')?.disabled).toBe(true);
  });

  it('lists the ratings with who, when and on which version', async () => {
    api.fetchBotFeedback.mockResolvedValue([
      {
        id: 1,
        rating: -1,
        comment: 'Missed the Q3 numbers',
        version: 2,
        user: { id: 'u2', nickname: 'Alice' },
        created_at: '2026-10-11T10:00:00.000Z',
      },
      {
        id: 2,
        rating: 1,
        comment: '',
        version: 2,
        user: { id: 'u3', nickname: 'Bo' },
        created_at: '2026-10-11T09:00:00.000Z',
      },
    ]);
    await renderDrawer();
    await click(document.querySelector('[data-testid="bots-profile-tab-feedback"]'));
    expect(api.fetchBotFeedback).toHaveBeenCalledWith(SAGE.id);
    expect(document.querySelector('[data-testid="bots-feedback-summary"]')?.textContent).toBe(
      '1 helpful · 1 not helpful',
    );
    const rows = [...document.querySelectorAll('[data-testid="bots-feedback-list"] li')];
    expect(rows.map((row) => row.getAttribute('data-rating'))).toEqual(['-1', '1']);
    expect(rows[0]!.textContent).toContain('Missed the Q3 numbers');
    expect(rows[0]!.textContent).toContain('Alice');
    expect(rows[0]!.textContent).toContain('v2');
  });

  it("shows someone else's public Agent by its public face only", async () => {
    const oracle: SharedBotView = {
      id: 'bot_oracle',
      name: 'Oracle',
      role: 'Analyst',
      description: 'Answers revenue questions',
      avatar: { color: 'ocean' },
      template_key: null,
      owner: { id: 'u2', nickname: 'Alice' },
      dm_session_id: null,
      available: true,
    };
    api.openPublicAgent.mockResolvedValue({ conversation_id: 'dm-oracle' });
    useBotsStore.setState({ bots: [SAGE], sharedBots: [oracle], profileBotId: oracle.id });
    await renderDrawer();
    const profile = document.querySelector('[data-testid="bots-shared-profile"]')!;
    expect(profile.textContent).toContain('Oracle');
    expect(profile.textContent).toContain('Published by Alice');
    expect(profile.textContent).toContain('Answers revenue questions');
    // Nothing of its owner's: no tabs, instructions, memories, files or versions — and nothing loaded.
    expect(document.querySelector('[data-testid="bots-profile-tab-profile"]')).toBeNull();
    expect(api.listBotMemories).not.toHaveBeenCalled();
    expect(api.listBotVersions).not.toHaveBeenCalled();
    expect(api.listBotFiles).not.toHaveBeenCalled();

    await click(document.querySelector('[data-testid="bots-shared-profile-message"]'));
    expect(api.openPublicAgent).toHaveBeenCalledWith('bot_oracle');
    expect(window.location.hash).toBe('#/bots?c=dm-oracle');
    expect(useBotsStore.getState().profileBotId).toBeNull();
  });
});
