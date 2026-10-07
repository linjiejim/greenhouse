/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultAccessView, VaultItemView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { ToastContainer } from '../../components/ui';
import { useAuthStore } from '../../stores/auth-store';
import { BotsApiError } from '../../lib/api/bots';
import { PasswordsPanel, draftToWrite } from './passwords';

const api = vi.hoisted(() => ({
  fetchVault: vi.fn(),
  createVaultItem: vi.fn(),
  updateVaultItem: vi.fn(),
  deleteVaultItem: vi.fn(),
  setVaultAlwaysOrigins: vi.fn(),
  fetchVaultLog: vi.fn(),
  listBots: vi.fn(),
}));
// Partial mock: the real BotsApiError / isBotsApiError stay, so the code →
// message map runs against real errors.
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GITHUB: VaultItemView = {
  id: 'vlt_1',
  label: 'GitHub (work)',
  origins: ['https://github.com'],
  username_hint: 'm•••@example.com',
  has_password: true,
  has_totp: true,
  policy: 'ask',
  always_origins: ['https://github.com'],
  last_used_at: null,
  created_at: '2026-10-01T08:00:00.000Z',
};

let root: ReturnType<typeof createRoot> | null = null;

/** CrudPage debounces its first load by 200 ms. */
async function settle(ms = 260) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: [createElement(PasswordsPanel, { key: 'panel' }), createElement(ToastContainer, { key: 'toasts' })],
      }),
    );
  });
  await settle();
}

async function click(element: Element | null) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle(30);
}

async function fill(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) if (vi.isMockFunction(fn)) fn.mockReset();
  api.fetchVault.mockResolvedValue({ items: [GITHUB], available: true });
  api.fetchVaultLog.mockResolvedValue([]);
  api.listBots.mockResolvedValue({
    bots: [],
    archived_bots: [],
    computer: { state: 'disabled', reason: null, hardened: false },
    vault_available: true,
    pending_requests: 0,
  });
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia' } as never });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('draftToWrite', () => {
  it('omits blank write-only fields so stored secrets stay', () => {
    expect(
      draftToWrite(
        {
          label: ' GitHub ',
          sites: 'github.com/login',
          username: '',
          password: { value: '', clear: false },
          totp: { value: '', clear: false },
          policy: 'auto',
        },
        'edit',
      ),
    ).toEqual({ label: 'GitHub', origins: ['https://github.com'], policy: 'auto' });
  });

  it('clears on an explicit remove and normalises a pasted 2FA key', () => {
    expect(
      draftToWrite(
        {
          label: 'GitHub',
          sites: 'https://github.com',
          username: 'mia@example.com',
          password: { value: '', clear: true },
          totp: { value: 'jbsw y3dp ehpk 3pxp', clear: false },
          policy: 'ask',
        },
        'edit',
      ),
    ).toEqual({
      label: 'GitHub',
      origins: ['https://github.com'],
      policy: 'ask',
      username: 'mia@example.com',
      password: '',
      totp: 'JBSWY3DPEHPK3PXP',
    });
  });
});

describe('PasswordsPanel', () => {
  it('lists saved logins as metadata only and explains that Bots never see them', async () => {
    await renderPanel();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Bots never see these values');
    expect(text).toContain('GitHub (work)');
    expect(text).toContain('m•••@example.com');
    expect(text).toContain('Ask every time');
    expect(text).toContain('2FA code');
    expect(text).not.toContain('hunter2');
  });

  it('withdraws an "always allow" grant inline', async () => {
    api.setVaultAlwaysOrigins.mockResolvedValue({ ...GITHUB, always_origins: [] });
    await renderPanel();

    await click(document.querySelector('button[aria-label="Stop always allowing https://github.com"]'));
    expect(api.setVaultAlwaysOrigins).toHaveBeenCalledWith('vlt_1', []);
    expect(document.querySelector('button[aria-label="Stop always allowing https://github.com"]')).toBeNull();
  });

  it('validates sites line by line and saves the normalised origins', async () => {
    api.fetchVault.mockResolvedValue({ items: [], available: true });
    api.createVaultItem.mockResolvedValue(GITHUB);
    await renderPanel();
    expect(document.body.textContent).toContain('No saved logins yet');

    await click(document.querySelector('[data-testid="vault-add"]'));
    await fill('[data-testid="vault-field-label"]', 'GitHub');
    await fill('[data-testid="vault-field-sites"]', 'github.com/login\nnot a site');
    await fill('[data-testid="vault-field-password"]', 'hunter2');
    await click(document.querySelector('[data-testid="vault-submit"]'));

    expect(document.body.textContent).toContain('Line 2: "not a site" isn\'t a site');
    expect(api.createVaultItem).not.toHaveBeenCalled();

    await fill('[data-testid="vault-field-sites"]', 'github.com/login');
    await click(document.querySelector('[data-testid="vault-policy-auto"]'));
    await click(document.querySelector('[data-testid="vault-submit"]'));

    expect(api.createVaultItem).toHaveBeenCalledWith({
      label: 'GitHub',
      origins: ['https://github.com'],
      policy: 'auto',
      password: 'hunter2',
    });
  });

  it('requires a password or a 2FA secret, and checks the 2FA key format', async () => {
    api.fetchVault.mockResolvedValue({ items: [], available: true });
    await renderPanel();

    await click(document.querySelector('[data-testid="vault-add"]'));
    await fill('[data-testid="vault-field-label"]', 'Example');
    await fill('[data-testid="vault-field-sites"]', 'example.com');
    await click(document.querySelector('[data-testid="vault-submit"]'));
    expect(document.body.textContent).toContain('Save a password or a 2FA secret.');

    await fill('[data-testid="vault-field-totp"]', 'not-a-key');
    await click(document.querySelector('[data-testid="vault-submit"]'));
    expect(document.body.textContent).toContain("That doesn't look like a 2FA setup key");
    expect(api.createVaultItem).not.toHaveBeenCalled();
  });

  it('edits without revealing secrets: blank keeps, the switch removes', async () => {
    api.updateVaultItem.mockResolvedValue({ ...GITHUB, has_password: false });
    await renderPanel();

    await click(document.querySelector('[data-testid="vault-edit"]'));
    const password = document.querySelector<HTMLInputElement>('[data-testid="vault-field-password"]')!;
    expect(password.value).toBe('');
    expect(password.placeholder).toBe('Leave blank to keep the saved password');
    expect(document.querySelector<HTMLInputElement>('[data-testid="vault-field-username"]')!.placeholder).toBe(
      'Leave blank to keep m•••@example.com',
    );

    const remove = [...document.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Remove the saved password'),
    );
    await click(remove?.querySelector('input') ?? null);
    await click(document.querySelector('[data-testid="vault-submit"]'));

    expect(api.updateVaultItem).toHaveBeenCalledWith('vlt_1', {
      label: 'GitHub (work)',
      origins: ['https://github.com'],
      policy: 'ask',
      password: '',
    });
  });

  it('says so when the server cannot store secrets', async () => {
    api.fetchVault.mockResolvedValue({ items: [], available: false });
    await renderPanel();

    expect(document.body.textContent).toContain('Passwords are unavailable');
    expect(document.body.textContent).toContain('administrator needs to configure the encryption key');
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('[data-testid="vault-add"]')).toBeNull();
  });

  it('shows the access log with the Bot, the site and how each fill was approved', async () => {
    const entry: VaultAccessView = {
      id: 7,
      item_label: 'GitHub (work)',
      bot_id: 'bot_sage',
      origin: 'https://github.com',
      action: 'fill_login',
      outcome: 'filled',
      approval: 'always',
      created_at: '2026-10-05T09:00:00.000Z',
    };
    api.fetchVaultLog.mockResolvedValue([
      entry,
      { ...entry, id: 8, bot_id: 'bot_gone', outcome: 'origin_mismatch' },
      { ...entry, id: 9, bot_id: 'bot_old' },
    ]);
    api.listBots.mockResolvedValue({
      bots: [{ id: 'bot_sage', name: 'Sage', status: 'active' }],
      archived_bots: [{ id: 'bot_old', name: 'Fern', status: 'archived' }],
      computer: { state: 'disabled', reason: null, hardened: false },
      vault_available: true,
      pending_requests: 0,
    });
    await renderPanel();

    const logTab = [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Access log');
    await click(logTab ?? null);
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Sage');
    expect(text).toContain('Filled sign-in');
    expect(text).toContain('Always allowed');
    expect(text).toContain('Wrong site');
    expect(text).toContain('Deleted Bot');
    // An archived Bot keeps its name in the log.
    expect(text).toContain('Fern (archived)');
  });

  it('keeps auto-fill and "always allowed" grants visible and revocable on phones', async () => {
    api.fetchVault.mockResolvedValue({ items: [{ ...GITHUB, policy: 'auto' }], available: true });
    api.setVaultAlwaysOrigins.mockResolvedValue({ ...GITHUB, always_origins: [] });
    await renderPanel();

    // The phone-only block under the login's name (the two columns are hidden below md).
    const mobile = document.querySelector('[data-testid="vault-row-mobile-access"]');
    expect(mobile?.className).toContain('md:hidden');
    expect(mobile?.textContent).toContain('Fill automatically');
    expect(mobile?.textContent).toContain('https://github.com');

    await click(mobile?.querySelector('button[aria-label="Stop always allowing https://github.com"]') ?? null);
    expect(api.setVaultAlwaysOrigins).toHaveBeenCalledWith('vlt_1', []);
    // The ✕ does not also open the row's edit dialog.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mobile?.textContent).not.toContain('https://github.com');
  });

  it("explains a refused save in the member's words, and falls back to the server's message", async () => {
    api.fetchVault.mockResolvedValue({ items: [], available: true });
    api.createVaultItem.mockRejectedValueOnce(new BotsApiError('origin bad', 400, 'origin_invalid'));
    await renderPanel();

    await click(document.querySelector('[data-testid="vault-add"]'));
    await fill('[data-testid="vault-field-label"]', 'GitHub');
    await fill('[data-testid="vault-field-sites"]', 'github.com');
    await fill('[data-testid="vault-field-password"]', 'hunter2');
    await click(document.querySelector('[data-testid="vault-submit"]'));
    expect(document.body.textContent).toContain("One of the sites isn't valid.");

    api.createVaultItem.mockRejectedValueOnce(new BotsApiError('Something new went wrong', 400, 'brand_new_code'));
    await click(document.querySelector('[data-testid="vault-submit"]'));
    expect(document.body.textContent).toContain('Something new went wrong');
  });
});
