/**
 * Tools whose output depends on the Bot's page: request_takeover (card
 * payload from the browser, not the model) and vault list (site matching).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, VaultItemRow } from '@greenhouse/db';
import { BrowserSession } from '../../computer/browser-session.js';
import { leaseRegistryFor } from '../../computer/tab-leases.js';
import { encryptVaultField } from '../../vault/crypto.js';
import { displayUrl, requestTakeover } from '../takeover.js';
import { HUMAN_WAIT_HOLD_MS } from '../../computer/limits.js';
import { runVaultAction } from '../vault.js';
import {
  chromiumAvailable,
  fakeComputer,
  launchTestChromium,
  type FakeComputer,
  type TestChromium,
} from '../../__tests__/helpers/chromium.js';
import { startFixtureSite, type FixtureSite } from '../../__tests__/helpers/fixture-server.js';
import { testTurn } from '../../__tests__/helpers/turn.js';

const KEY = 'e5'.repeat(32);
const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;

describe('displayUrl', () => {
  it('keeps origin + path, drops query and fragment', () => {
    expect(displayUrl('https://github.com/login?return_to=%2Fsettings&token=abc#x')).toBe('https://github.com/login');
    expect(displayUrl('about:blank')).toBeNull();
    expect(displayUrl(null)).toBeNull();
  });
});

describe('request_takeover without a page', () => {
  it('turns a login request into a plain take-over card and ends the turn', async () => {
    const ctx = testTurn();
    const computer = fakeComputer({} as never, { isRunning: async () => false });
    const result = await requestTakeover(ctx, { kind: 'login', reason: 'Please sign in\n\nnow' }, computer.deps);
    // The card expires when it stops holding the member's computer.
    expect(ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      { reason: 'Please sign in now', kind: 'other', url: null },
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
    expect(ctx.stopAfterStep).toHaveBeenCalledWith('takeover');
    expect(result).toMatchObject({ requested: true, card: 'take_over' });
    expect(String(result.message)).toMatch(/End your turn NOW/);
  });

  it('does not stack a second card from the same Bot', async () => {
    const ctx = testTurn();
    vi.mocked(ctx.db.bots.listRequests).mockResolvedValueOnce([
      { id: 'brq_old', bot_id: 'bot_test', kind: 'takeover', payload: '{}' } as never,
    ]);
    const computer = fakeComputer({} as never, { isRunning: async () => false });
    const result = await requestTakeover(ctx, { kind: 'captcha', reason: 'CAPTCHA' }, computer.deps);
    expect(ctx.createRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ request_id: 'brq_old', already_pending: true });
    expect(ctx.stopAfterStep).toHaveBeenCalledWith('takeover');
  });
});

describe.skipIf(!chromiumAvailable())('tools on a real page', { timeout: 90_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;
  let computer: FakeComputer;
  let n = 0;
  let vaultRows: VaultItemRow[];

  beforeAll(async () => {
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
    site = await startFixtureSite();
    chromium = await launchTestChromium();
  });
  afterAll(async () => {
    await chromium?.close();
    await site?.close();
    if (originalKey === undefined) delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    else process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = originalKey;
  });
  beforeEach(() => {
    computer = fakeComputer(chromium.browser);
    const now = new Date().toISOString();
    const row = (id: string, origins: string[], extra: Partial<VaultItemRow> = {}): VaultItemRow => ({
      id,
      user_id: 'u1',
      label: `Login ${id}`,
      origins: JSON.stringify(origins),
      username_enc: encryptVaultField('u1', id, 'username', 'me@example.com'),
      username_hint: 'me***@example.com',
      password_enc: encryptVaultField('u1', id, 'password', 'never-shown'),
      totp_enc: null,
      policy: 'ask',
      always_origins: '[]',
      last_used_at: null,
      created_at: now,
      updated_at: now,
      ...extra,
    });
    vaultRows = [row('vlt_site', [site.origin]), row('vlt_gh', ['https://github.com'])];
  });
  afterEach(async () => {
    const registry = leaseRegistryFor(chromium.browser);
    for (const lease of registry.list()) await registry.release(lease.key);
  });

  async function botOnPage(path: string) {
    const botId = `bot_page_${++n}`;
    const db = {
      bots: { listRequests: vi.fn(async () => []) },
      vault: { list: async () => vaultRows },
    } as unknown as DatabaseProvider;
    const ctx = testTurn({ db, bot: { ...testTurn().bot, id: botId } });
    await new BrowserSession(
      {
        db,
        userId: 'u1',
        botId,
        sessionId: ctx.sessionId,
        turnId: 't',
        background: false,
        signal: ctx.signal,
        markTainted: () => undefined,
        noteObservation: () => undefined,
        vaultMatches: null,
      },
      computer.deps,
    ).run({ action: 'open', url: `${site.origin}${path}` });
    return ctx;
  }

  it('raises a secure sign-in card with the origin read from the browser and matching entries', async () => {
    const ctx = await botOnPage('/login?next=%2Fsecret-token');
    const result = await requestTakeover(
      ctx,
      { kind: 'login', reason: 'I need you to sign in to the fixture site' },
      computer.deps,
    );
    expect(ctx.createRequest).toHaveBeenCalledWith(
      'login',
      {
        reason: 'I need you to sign in to the fixture site',
        kind: 'login',
        origin: site.origin,
        url: `${site.origin}/login`,
        vault_matches: [{ id: 'vlt_site', label: 'Login vlt_site', username_hint: 'me***@example.com' }],
      },
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
    expect(result).toMatchObject({ card: 'secure_sign_in' });
    expect(ctx.stopAfterStep).toHaveBeenCalledWith('takeover');
  });

  it('raises a take-over card for a CAPTCHA', async () => {
    const ctx = await botOnPage('/captcha');
    await requestTakeover(ctx, { kind: 'captcha', reason: 'There is a CAPTCHA' }, computer.deps);
    expect(ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      { reason: 'There is a CAPTCHA', kind: 'captcha', url: `${site.origin}/captcha` },
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
  });

  it('lists vault entries as metadata, marking the ones for the current page', async () => {
    const ctx = await botOnPage('/login');
    const result = await runVaultAction(ctx, { action: 'list' }, computer.deps);
    expect(result.current_site).toBe(site.origin);
    expect(result.entries).toEqual([
      expect.objectContaining({ id: 'vlt_site', matches_current_page: true, has_password: true }),
      expect.objectContaining({ id: 'vlt_gh', matches_current_page: false }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/never-shown|me@example\.com/);
    expect(await runVaultAction(ctx, { action: 'fill_login' }, computer.deps)).toMatchObject({ code: 'invalid' });
  });
});
