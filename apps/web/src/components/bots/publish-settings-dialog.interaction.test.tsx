/** @vitest-environment happy-dom */

/**
 * Publishing settings (spec 20261011-agent-first-class P4): what a save writes — audience, grants
 * (never another Agent's reference folder), budget — and the first publish riding along.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotPublicationView, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import type { DriveFolder } from '../../lib/api/drive';
import { grantableFolders, parseTokens, PublishSettingsDialog } from './publish-settings-dialog';

const api = vi.hoisted(() => ({
  updateBotPublication: vi.fn(),
  fetchShareableUsers: vi.fn(),
  listGroups: vi.fn(),
  listDriveFolders: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  updateBotPublication: api.updateBotPublication,
}));
vi.mock('../../lib/api/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/sessions')>()),
  fetchShareableUsers: api.fetchShareableUsers,
}));
vi.mock('../../lib/api/groups', () => ({ listGroups: api.listGroups }));
vi.mock('../../lib/api/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/drive')>()),
  listDriveFolders: api.listDriveFolders,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function folder(id: number, name: string, parent: number | null, extra: Partial<DriveFolder> = {}): DriveFolder {
  return {
    id,
    scope: 'kb',
    parent_id: parent,
    name,
    visibility: 'private',
    owner_user_id: 'u1',
    base_id: null,
    sort_order: 0,
    created_by: 'u1',
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

const SAGE = {
  id: 'bot_sage',
  name: 'Sage',
  current_version: 3,
} as BotView;

const PRIVATE: BotPublicationView = {
  visibility: 'private',
  published_version: null,
  current_version: 3,
  paused: false,
  users: 0,
  audience: { everyone: false, user_ids: [], group_ids: [] },
  grants: { kb_folder_ids: [], computer: false },
  budget: { monthly_tokens: null, daily_tokens_per_user: null },
};

describe('grantableFolders / parseTokens', () => {
  it('paths every team and personal folder, without any Agent reference folder or its subtree', () => {
    const team = [folder(1, 'Sales', null, { visibility: 'team' }), folder(2, 'Playbooks', 1, { visibility: 'team' })];
    const personal = [
      folder(10, 'Notes', null),
      folder(20, 'Sage files', null, { bot_id: 'bot_sage' }),
      folder(21, 'Drafts', 20),
    ];
    expect(grantableFolders(team, personal)).toEqual([
      { id: 10, path: 'Notes', visibility: 'private' },
      { id: 1, path: 'Sales', visibility: 'team' },
      { id: 2, path: 'Sales / Playbooks', visibility: 'team' },
    ]);
  });

  it('reads empty as the default and refuses anything but a whole number in range', () => {
    expect(parseTokens('')).toBeNull();
    expect(parseTokens(' 2,000,000 ')).toBe(2_000_000);
    expect(parseTokens('1.5')).toBe('invalid');
    expect(parseTokens('0')).toBe('invalid');
    expect(parseTokens('2000000000')).toBe('invalid');
  });
});

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(view: BotPublicationView, startPublic: boolean, onSaved = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(PublishSettingsDialog, { bot: SAGE, view, startPublic, onClose: vi.fn(), onSaved }),
      }),
    ),
  );
  await flush();
  return onSaved;
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
}

function labelled(text: string): HTMLInputElement {
  const label = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === text);
  const input = label?.querySelector('input');
  if (!input) throw new Error(`No checkbox labelled ${text}`);
  return input;
}

async function type(input: Element | null, value: string) {
  if (!input) throw new Error('missing input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } as never });
  api.fetchShareableUsers.mockResolvedValue([
    { id: 'u1', nickname: 'Mia', email: 'mia@x', role: 'team' },
    { id: 'u2', nickname: 'Alice', email: 'alice@x', role: 'team' },
  ]);
  api.listGroups.mockResolvedValue([
    { id: 7, name: 'Finance', description: '', created_by: 'u1', created_at: null, updated_at: null },
  ]);
  api.listDriveFolders.mockImplementation(async (owner: { visibility: string }) =>
    owner.visibility === 'team'
      ? [folder(1, 'Sales', null, { visibility: 'team' })]
      : [folder(10, 'Notes', null), folder(20, 'Sage files', null, { bot_id: 'bot_sage' })],
  );
  api.updateBotPublication.mockImplementation(async () => ({ ...PRIVATE, visibility: 'public', published_version: 3 }));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PublishSettingsDialog', () => {
  it('publishes the current version the first time it goes public, to the chosen audience', async () => {
    const onSaved = await render(PRIVATE, true);
    // The owner is not offered to themselves, and an Agent's reference folder is never grantable.
    expect(document.querySelector('[data-testid="bots-publish-members"]')?.textContent).not.toContain('Mia');
    expect(document.querySelector('[data-testid="bots-publish-folders"]')?.textContent).not.toContain('Sage files');
    expect(document.body.textContent).toContain('Saving publishes the current version (v3).');

    // Nobody chosen yet: refused before any request.
    await click(document.querySelector('[data-testid="bots-publish-save"]'));
    expect(api.updateBotPublication).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Choose who can use it');

    await click(labelled('Alice'));
    await click(labelled('Finance'));
    await click(labelled('TeamSales'));
    await type(document.querySelector('[data-testid="bots-publish-daily"]'), '50000');
    await click(document.querySelector('[data-testid="bots-publish-save"]'));

    expect(api.updateBotPublication).toHaveBeenCalledWith('bot_sage', {
      visibility: 'public',
      audience: { everyone: false, user_ids: ['u2'], group_ids: [7] },
      grants: { computer: false, kb_folder_ids: [1] },
      budget: { monthly_tokens: null, daily_tokens_per_user: 50_000 },
      publish: true,
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ published_version: 3 }));
  });

  it('keeps the granted folders as they are when the folder lists could not be read', async () => {
    api.listDriveFolders.mockRejectedValue(new Error('down'));
    await render(
      {
        ...PRIVATE,
        visibility: 'public',
        published_version: 3,
        audience: { everyone: true, user_ids: [], group_ids: [] },
        grants: { kb_folder_ids: [42], computer: true },
      },
      false,
    );
    await click(document.querySelector('[data-testid="bots-publish-save"]'));
    const write = api.updateBotPublication.mock.calls[0]![1];
    expect(write.grants).toEqual({ computer: true });
    // Up to date: nothing to publish.
    expect(write.publish).toBeUndefined();
  });

  it('refuses a token limit that is not a whole number', async () => {
    await render(
      {
        ...PRIVATE,
        visibility: 'public',
        published_version: 3,
        audience: { everyone: true, user_ids: [], group_ids: [] },
      },
      false,
    );
    await type(document.querySelector('[data-testid="bots-publish-monthly"]'), 'lots');
    await click(document.querySelector('[data-testid="bots-publish-save"]'));
    expect(api.updateBotPublication).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Enter a whole number of tokens');
  });
});
