/** @vitest-environment happy-dom */

/**
 * The directory (`/api/sessions/shareable-users`) leaves the caller out, so a
 * group the viewer created used to read "Members managed by a3310857-2c7d-…".
 * It says "you"; a manager missing from the directory is "an unknown member".
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShareableUser, UserGroup } from '@greenhouse/types/api';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { PrincipalPicker } from './principal-picker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const users: ShareableUser[] = [{ id: 'u2', nickname: 'Mei', email: 'mei@example.com', role: 'team' }];
const group = (id: number, name: string, createdBy: string): UserGroup => ({
  id,
  name,
  description: '',
  created_by: createdBy,
  member_count: 3,
  created_at: null,
  updated_at: null,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const previousUser = useAuthStore.getState().currentUser;

beforeEach(() => {
  useAuthStore.setState({ currentUser: { ...(previousUser ?? {}), id: 'me-3310857' } as never });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAuthStore.setState({ currentUser: previousUser });
});

async function render(locale: 'en' | 'zh') {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale}>
        <PrincipalPicker
          value={{ userIds: [], groupIds: [] }}
          onChange={() => undefined}
          users={users}
          groups={[group(7, 'Finance', 'u2'), group(8, 'Mine', 'me-3310857'), group(9, 'Gone', 'a3310857-left')]}
        />
      </I18nProvider>,
    );
  });
  return container.textContent ?? '';
}

describe('PrincipalPicker group managers', () => {
  it('says "you" for the viewer’s own group and never prints a raw user id', async () => {
    const text = await render('en');
    expect(text).toContain('Members managed by Mei');
    expect(text).toContain('Members managed by you');
    expect(text).toContain('Members managed by an unknown member');
    expect(text).not.toContain('me-3310857');
    expect(text).not.toContain('a3310857-left');
    expect(await render('zh')).toContain('成员由你管理');
  });
});
