/** @vitest-environment happy-dom */

/**
 * "Browse Agents" (spec 20261011-agent-first-class P4): other members' public Agents, whose they
 * are, and "Talk" into the member's own conversation with one.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedBotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { ToastContainer } from '../ui';
import { useBotsStore } from './bots-store';
import { AgentDirectoryDialog } from './agent-directory-dialog';

const api = vi.hoisted(() => ({
  listPublicAgents: vi.fn(),
  openPublicAgent: vi.fn(),
  listBots: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function agent(id: string, name: string, extra: Partial<SharedBotView> = {}): SharedBotView {
  return {
    id,
    name,
    role: 'Analyst',
    description: `${name} answers questions`,
    avatar: { color: 'ocean' },
    template_key: null,
    owner: { id: 'u2', nickname: 'Alice' },
    dm_session_id: null,
    available: true,
    ...extra,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(onClose = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(
          'div',
          null,
          createElement(AgentDirectoryDialog, { open: true, onClose }),
          createElement(ToastContainer),
        ),
      }),
    ),
  );
  await flush();
  return onClose;
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="bots-directory-row"]')];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listBots.mockResolvedValue({
    bots: [],
    archived_bots: [],
    shared_bots: [],
    computer: null,
    vault_available: false,
    pending_requests: 0,
  });
  api.listConversations.mockResolvedValue({ conversations: [] });
  useBotsStore.getState().reset();
  window.location.hash = '#/settings/bots';
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useBotsStore.getState().reset();
});

describe('AgentDirectoryDialog', () => {
  it('lists the Agents shared with the member, by name, with whose they are', async () => {
    api.listPublicAgents.mockResolvedValue([
      agent('bot_scribe', 'Scribe', { owner: { id: 'u3', nickname: 'Bo' } }),
      agent('bot_oracle', 'Oracle', { dm_session_id: 'dm-oracle' }),
    ]);
    await render();
    expect(rows().map((row) => row.dataset.botId)).toEqual(['bot_oracle', 'bot_scribe']);
    expect(rows()[0]!.textContent).toContain('by Alice');
    expect(rows()[1]!.textContent).toContain('by Bo');
    // An existing conversation is opened, a new one is started.
    expect(rows()[0]!.querySelector('[data-testid="bots-directory-talk"]')?.textContent).toBe('Open');
    expect(rows()[1]!.querySelector('[data-testid="bots-directory-talk"]')?.textContent).toBe('Talk');
  });

  it('says when nothing is shared yet', async () => {
    api.listPublicAgents.mockResolvedValue([]);
    await render();
    expect(document.body.textContent).toContain('No Agents shared with you yet');
  });

  it('starts the conversation and opens it, already named', async () => {
    api.listPublicAgents.mockResolvedValue([agent('bot_scribe', 'Scribe')]);
    api.openPublicAgent.mockResolvedValue({ conversation_id: 'dm-scribe' });
    // The next list read names it too (its DM exists now).
    api.listBots.mockResolvedValue({
      bots: [],
      archived_bots: [],
      shared_bots: [agent('bot_scribe', 'Scribe', { dm_session_id: 'dm-scribe' })],
      computer: null,
      vault_available: false,
      pending_requests: 0,
    });
    const onClose = await render();
    await act(async () =>
      rows()[0]!
        .querySelector('[data-testid="bots-directory-talk"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await flush();
    expect(api.openPublicAgent).toHaveBeenCalledWith('bot_scribe');
    expect(onClose).toHaveBeenCalled();
    expect(window.location.hash).toBe('#/bots?c=dm-scribe');
    expect(useBotsStore.getState().sharedBots).toEqual([
      expect.objectContaining({ id: 'bot_scribe', dm_session_id: 'dm-scribe', available: true }),
    ]);
  });

  it('explains an Agent withdrawn meanwhile and reads the list again', async () => {
    api.listPublicAgents.mockResolvedValueOnce([agent('bot_scribe', 'Scribe')]).mockResolvedValueOnce([]);
    api.openPublicAgent.mockRejectedValue(new BotsApiError('Agent not found', 404));
    await render();
    await act(async () =>
      rows()[0]!
        .querySelector('[data-testid="bots-directory-talk"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await flush();
    expect(document.body.textContent).toContain('This Agent is no longer available to you');
    expect(api.listPublicAgents).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(0);
  });
});
