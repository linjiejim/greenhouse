/** @vitest-environment happy-dom */

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError } from '../../lib/api/bots';
import { useAuthStore, useProfileStore } from '../../stores';
import { ToastContainer } from '../ui';
import { useBotsStore } from './bots-store';
import { NewBotDialog } from './new-bot-dialog';

const api = vi.hoisted(() => ({ createBot: vi.fn(), addConversationMember: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IVY: BotView = {
  id: 'bot_ivy',
  name: 'Ivy',
  role: '',
  instructions: '',
  avatar: { color: 'forest' },
  model_id: null,
  template_key: null,
  status: 'active',
  dm_session_id: 'dm-ivy',
  last_active_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
};

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

beforeEach(() => {
  api.createBot.mockReset();
  api.addConversationMember.mockReset();
  useBotsStore.getState().reset();
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } as never });
  useProfileStore.setState({ profiles: [], models: [], fetchProfiles: async () => {} });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('NewBotDialog from Invite', () => {
  it('reports a created Bot that could not join as exactly that — no orphan "create failed"', async () => {
    api.createBot.mockResolvedValue({ bot: IVY, dm_session_id: 'dm-ivy' });
    api.addConversationMember.mockRejectedValue(
      new BotsApiError('At most 6 Bots per conversation', 400, 'member_limit'),
    );
    const onCreated = vi.fn();
    // What the Bots page does: close on onCreated.
    function Host() {
      const [open, setOpen] = useState(true);
      return createElement(NewBotDialog, {
        open,
        inviteTo: 'grp-1',
        onClose: () => setOpen(false),
        onCreated: (result) => {
          onCreated(result);
          setOpen(false);
        },
      });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement('div', null, createElement(Host), createElement(ToastContainer)),
        }),
      ),
    );
    await flush();

    await click(document.querySelector('[data-template="custom"]'));
    const name = document.querySelector<HTMLInputElement>('[data-testid="bots-new-bot-form"] input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Ivy');
      name!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(document.querySelector('[data-testid="bots-create-bot"]'));

    expect(api.createBot).toHaveBeenCalledTimes(1);
    expect(api.addConversationMember).toHaveBeenCalledWith('grp-1', IVY.id);
    expect(onCreated).toHaveBeenCalledWith({ bot: IVY, dmSessionId: 'dm-ivy', inviteFailed: true });
    expect(document.body.textContent).toContain(
      "Ivy was created but couldn't join this conversation: At most 6 Bots per conversation",
    );
    // Not "create failed" (a retry could only hit "name taken"), and the dialog is gone.
    expect(document.body.textContent).not.toContain('Could not save the Bot');
    expect(document.querySelector('[data-testid="bots-new-bot-form"]')).toBeNull();
    expect(useBotsStore.getState().bots.map((bot) => bot.id)).toEqual([IVY.id]);
  });
});
