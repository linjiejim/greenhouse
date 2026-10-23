/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@greenhouse/types/api';

const usableBy = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchRunProfilesUsableBy: usableBy,
}));

import { I18nProvider } from '../lib/i18n';
import { AutomationProfileSelect } from './automation-profile-select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const p = (over: Partial<Profile>) => ({ tools: [], ...over }) as Profile;
// What the signed-in super sees: system, their own private, a shared one.
const adminView = [
  p({ id: 'sprouty', name: 'Sprouty' }),
  p({ id: 'custom:1', name: 'Admin private', is_custom: true, user_id: 'admin' }),
  p({ id: 'custom:2', name: 'Team shared', is_custom: true, user_id: 'bob', is_shared: true }),
];

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => usableBy.mockReset());
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(ownerId: string | undefined, value = 'sprouty') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(AutomationProfileSelect, {
          value,
          onChange: () => {},
          profiles: adminView,
          currentUserId: 'admin',
          ownerId,
          nameOf: (id: string) => id,
        }),
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return [...container.querySelectorAll('option')].map((option) => option.textContent);
}

describe('AutomationProfileSelect', () => {
  it('offers the signed-in member’s own and shared run profiles for a new or own automation', async () => {
    expect(await render(undefined)).toEqual(['Sprouty', 'Admin private', 'Team shared']);
    expect(await render('admin')).toEqual(['Sprouty', 'Admin private', 'Team shared']);
    expect(usableBy).not.toHaveBeenCalled();
  });

  it('offers the OWNER’s run profiles when a super edits a member’s automation', async () => {
    usableBy.mockResolvedValue([
      p({ id: 'custom:7', name: 'Maya private', is_custom: true, user_id: 'maya' }),
      p({ id: 'custom:2', name: 'Team shared', is_custom: true, user_id: 'bob', is_shared: true }),
    ]);
    const options = await render('maya');
    expect(usableBy).toHaveBeenCalledWith('maya');
    expect(options).toEqual(['Sprouty', 'Maya private', 'Team shared']);
    expect(options).not.toContain('Admin private');
  });

  it('keeps showing an automation’s pinned run profile version', async () => {
    usableBy.mockResolvedValue([]);
    expect(await render('maya', 'custom:9@3')).toEqual(['Sprouty', 'custom:9@3']);
  });
});
