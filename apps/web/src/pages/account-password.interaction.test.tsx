/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';

const api = vi.hoisted(() => ({
  inspect: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('../lib/api/password-link', () => ({
  inspectPasswordLink: api.inspect,
  completePasswordLink: api.complete,
}));

const { AccountPasswordPage } = await import('./account-password');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/#/activate?token=mail-secret');
  api.inspect.mockResolvedValue({
    ok: true,
    data: {
      purpose: 'invite',
      masked_email: 'te***@example.com',
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(onSuccess = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(AccountPasswordPage, { initialToken: 'mail-secret', onSuccess }),
      }),
    );
  });
  return onSuccess;
}

function enter(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
}

describe('AccountPasswordPage', () => {
  it('captures the fragment token in memory and removes it before inspecting', async () => {
    await mount();

    expect(window.location.hash).toBe('#/activate');
    expect(window.location.href).not.toContain('mail-secret');
    expect(api.inspect).toHaveBeenCalledWith('mail-secret');
    expect(container?.textContent).toContain('te***@example.com');
  });

  it('consumes the token only when a matching new password is submitted', async () => {
    const user = { id: 'user-1', email: 'teammate@example.com', nickname: 'Team Mate', role: 'team' };
    api.complete.mockResolvedValue({ ok: true, data: { user } });
    const onSuccess = await mount();

    const inputs = Array.from(container!.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    await act(async () => {
      enter(inputs[0]!, 'ReplacementPassword123!');
      enter(inputs[1]!, 'ReplacementPassword123!');
    });
    expect(api.complete).not.toHaveBeenCalled();

    await act(async () => {
      container?.querySelector('form')?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });

    expect(api.complete).toHaveBeenCalledWith('mail-secret', 'ReplacementPassword123!');
    expect(onSuccess).toHaveBeenCalledWith(user);
    expect(window.location.hash).toBe('#/chat');
  });
});
