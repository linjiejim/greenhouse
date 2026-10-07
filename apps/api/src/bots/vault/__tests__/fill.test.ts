/**
 * Vault fills end to end: a real Chromium, a local sign-in site, the real
 * crypto and an in-memory vault. Asserts what the SITE received (form posts),
 * what the Bot got back (never a value), what was logged, and every refusal
 * path (origin mismatch, navigation during approval, cross-origin iframe).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, VaultItemRow } from '@greenhouse/db';
import { abortComputerActions } from '../../computer/access.js';
import { BrowserSession, type ComputerTurn, type Observation } from '../../computer/browser-session.js';
import { leaseRegistryFor } from '../../computer/tab-leases.js';
import { encryptVaultField } from '../crypto.js';
import { fillLogin, fillSecureLogin, fillTotp, SecureLoginError, type FillTurn } from '../fill.js';
import { currentTotp } from '../totp.js';
import { foreignTurnReads, noteTurnObservation } from '../turn-observations.js';
import {
  chromiumAvailable,
  fakeComputer,
  launchTestChromium,
  type FakeComputer,
  type TestChromium,
} from '../../__tests__/helpers/chromium.js';
import { startFixtureSite, type FixtureSite } from '../../__tests__/helpers/fixture-server.js';

const KEY = 'c3'.repeat(32);
// base32("12345678901234567890") — the public RFC 6238 test vector, not a credential.
const RFC6238_SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const USER = 'u_fill';

type AccessRow = Record<string, unknown>;

function memoryVault() {
  const rows = new Map<string, VaultItemRow>();
  const access: AccessRow[] = [];
  const vault = {
    get: async (userId: string, id: string) => {
      const row = rows.get(id);
      return row && row.user_id === userId ? row : undefined;
    },
    list: async (userId: string) => [...rows.values()].filter((r) => r.user_id === userId),
    update: async (userId: string, id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row || row.user_id !== userId) return undefined;
      const next = { ...row } as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) next[k] = Array.isArray(v) ? JSON.stringify(v) : v;
      rows.set(id, next as VaultItemRow);
      return next as VaultItemRow;
    },
    touch: async () => undefined,
    logAccess: async (row: AccessRow) => {
      access.push(row);
    },
  };
  return { rows, access, db: { vault } as unknown as DatabaseProvider };
}

function item(
  id: string,
  origins: string[],
  secrets: { username?: string; password?: string; totp?: string },
  extra: Partial<VaultItemRow> = {},
): VaultItemRow {
  const now = new Date().toISOString();
  return {
    id,
    user_id: USER,
    label: `Item ${id}`,
    origins: JSON.stringify(origins),
    username_enc: secrets.username ? encryptVaultField(USER, id, 'username', secrets.username) : null,
    username_hint: secrets.username ? 'me***@example.com' : '',
    password_enc: secrets.password ? encryptVaultField(USER, id, 'password', secrets.password) : null,
    totp_enc: secrets.totp ? encryptVaultField(USER, id, 'totp', secrets.totp) : null,
    policy: 'ask',
    always_origins: '[]',
    last_used_at: null,
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

describe.skipIf(!chromiumAvailable())('vault fills on a real browser', { timeout: 90_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;
  let other: FixtureSite;
  let computer: FakeComputer;
  let store: ReturnType<typeof memoryVault>;
  let n = 0;
  const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
    other = await startFixtureSite();
    site = await startFixtureSite(() => other.origin);
    chromium = await launchTestChromium();
  });
  afterAll(async () => {
    await chromium?.close();
    await site?.close();
    await other?.close();
    if (originalKey === undefined) delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    else process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = originalKey;
  });
  beforeEach(() => {
    store = memoryVault();
    computer = fakeComputer(chromium.browser);
    site.submissions.length = 0;
    other.submissions.length = 0;
  });
  afterEach(async () => {
    const registry = leaseRegistryFor(chromium.browser);
    for (const lease of registry.list()) await registry.release(lease.key);
  });

  /**
   * A Bot with its tab on `url`, wired like computer/tools.ts and tools/vault.ts
   * do it: one turn object feeds the observation ledger (browser) and answers
   * the foreign-read question (vault). `before` runs first in the same turn.
   */
  async function botOn(
    url: string,
    overrides: Partial<FillTurn> = {},
    before?: (turn: { browser: BrowserSession; ledger: { tainted: boolean } }) => Promise<void>,
  ) {
    const botId = `bot_${++n}`;
    const ledger = { tainted: false };
    const computerTurn: ComputerTurn = {
      db: store.db,
      userId: USER,
      botId,
      sessionId: 's1',
      turnId: `t${n}`,
      background: false,
      signal: new AbortController().signal,
      markTainted: () => {
        ledger.tainted = true;
      },
      noteObservation: (origin) => noteTurnObservation(ledger, origin, ledger.tainted),
      vaultMatches: null,
    };
    const browser = new BrowserSession(computerTurn, computer.deps);
    if (before) await before({ browser, ledger });
    await browser.run({ action: 'open', url });
    const turn: FillTurn = {
      db: store.db,
      userId: USER,
      botId,
      botName: 'Sage',
      sessionId: 's1',
      locale: 'en',
      background: false,
      userTriggered: true,
      observedForeign: (patterns) => foreignTurnReads(ledger, patterns, ledger.tainted),
      signal: new AbortController().signal,
      requestApproval: vi.fn(async () => 'approve' as const),
      ...overrides,
    };
    const page = () =>
      leaseRegistryFor(chromium.browser).get({ kind: 'foreground', botId, sessionId: 's1' })!.currentPage()!;
    return { turn, browser, page, ledger };
  }

  it('fills and submits a login without showing the Bot anything (policy auto, member asked)', async () => {
    store.rows.set(
      'v1',
      item('v1', [site.origin], { username: 'me@example.com', password: 'S3cret-pass!' }, { policy: 'auto' }),
    );
    const { turn, browser } = await botOn(`${site.origin}/login`);

    const result = await fillLogin(turn, { item_id: 'v1', submit: true }, computer.deps);

    expect(result).toMatchObject({
      filled: true,
      origin: site.origin,
      fields: ['username', 'password'],
      submitted: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/me@example\.com|S3cret-pass!/);
    expect(turn.requestApproval).not.toHaveBeenCalled();
    expect(site.submissions[0]).toEqual({
      path: '/session',
      fields: { login: 'me@example.com', password: 'S3cret-pass!' },
    });
    expect(computer.remembered).toEqual(expect.arrayContaining(['me@example.com', 'S3cret-pass!']));
    expect(store.access).toEqual([
      expect.objectContaining({
        action: 'fill_login',
        outcome: 'filled',
        approval: 'auto',
        origin: site.origin,
        item_id: 'v1',
      }),
    ]);
    // The next observation (the OTP page) carries nothing secret either.
    const after = (await browser.run({ action: 'snapshot' })) as Observation;
    expect(after.title).toBe('Two-factor');
    expect(JSON.stringify(after)).not.toMatch(/S3cret-pass!/);
  });

  it('asks before filling a TOTP code (policy ask) and fills the right code', async () => {
    store.rows.set('v2', item('v2', [site.origin], { totp: RFC6238_SEED_B32 }));
    const { turn } = await botOn(`${site.origin}/otp`);

    const result = await fillTotp(turn, { item_id: 'v2', submit: true }, computer.deps);

    expect(result).toMatchObject({ filled: true, fields: ['otp'], submitted: true });
    expect(turn.requestApproval).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(turn.requestApproval).mock.calls[0]![0];
    expect(payload).toMatchObject({ action: 'vault_fill', allow_always: true });
    expect(payload.title).toContain('127.0.0.1');
    expect(payload.details).toEqual(expect.arrayContaining([{ label: 'Site', value: site.origin }]));
    const posted = site.submissions[0]!.fields.app_otp!;
    const now = Date.now();
    const valid = [currentTotp(RFC6238_SEED_B32, now - 30_000).code, currentTotp(RFC6238_SEED_B32, now).code];
    expect(valid).toContain(posted);
    expect(JSON.stringify(result)).not.toContain(posted);
    expect(store.access[0]).toMatchObject({ action: 'fill_totp', outcome: 'filled', approval: 'once' });
  });

  it('fills split one-digit OTP boxes', async () => {
    store.rows.set('v3', item('v3', [site.origin], { totp: RFC6238_SEED_B32 }, { policy: 'auto' }));
    const { turn } = await botOn(`${site.origin}/split-otp`);
    const result = await fillTotp(turn, { item_id: 'v3', submit: true }, computer.deps);
    expect(result).toMatchObject({ filled: true, fields: ['otp'] });
    const fields = site.submissions[0]!.fields;
    expect([0, 1, 2, 3, 4, 5].map((i) => fields[`d${i}`]).join('')).toMatch(/^\d{6}$/);
  });

  it('"always allow" is remembered per site and skips the next approval', async () => {
    store.rows.set('v4', item('v4', [site.origin], { username: 'me@example.com', password: 'pw-4' }));
    const first = await botOn(`${site.origin}/login`, { requestApproval: vi.fn(async () => 'always' as const) });
    expect(await fillLogin(first.turn, { item_id: 'v4' }, computer.deps)).toMatchObject({ filled: true });
    expect(JSON.parse(store.rows.get('v4')!.always_origins)).toEqual([site.origin]);

    const second = await botOn(`${site.origin}/login`);
    expect(await fillLogin(second.turn, { item_id: 'v4' }, computer.deps)).toMatchObject({ filled: true });
    expect(second.turn.requestApproval).not.toHaveBeenCalled();
    expect(store.access.map((a) => a.approval)).toEqual(['always', 'always']);
  });

  it('always asks in turns the member did not start, even for auto entries', async () => {
    store.rows.set(
      'v5',
      item('v5', [site.origin], { username: 'me@example.com', password: 'pw-5' }, { policy: 'auto' }),
    );
    const { turn } = await botOn(`${site.origin}/login`, { userTriggered: false });
    await fillLogin(turn, { item_id: 'v5' }, computer.deps);
    expect(turn.requestApproval).toHaveBeenCalledTimes(1);
  });

  describe('a turn that read another site or outside content', () => {
    const autoEntry = (id: string, extra: Partial<VaultItemRow> = {}) =>
      item(id, [site.origin], { username: 'me@example.com', password: `pw-${id}` }, { policy: 'auto', ...extra });

    it('asks before an auto fill, and fills nothing when the member declines', async () => {
      store.rows.set('f1', autoEntry('f1'));
      const { turn, page } = await botOn(
        `${site.origin}/login`,
        { requestApproval: vi.fn(async () => 'deny' as const) },
        // "Read this blog post" — the post says to sign in to the bank and submit.
        async ({ browser }) => void (await browser.run({ action: 'open', url: `${other.origin}/page2` })),
      );
      const result = await fillLogin(turn, { item_id: 'f1', submit: true }, computer.deps);
      expect(result).toMatchObject({ code: 'denied' });
      expect(turn.requestApproval).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(turn.requestApproval).mock.calls[0]![0];
      // The card says why, from the ledger (server-derived), and offers no "always".
      expect(payload.allow_always).toBe(false);
      expect(payload.details).toEqual(
        expect.arrayContaining([{ label: 'Why you are asked', value: 'In this turn the Bot also read: 127.0.0.1' }]),
      );
      expect(await page().inputValue('input[name=password]')).toBe('');
      expect(site.submissions).toEqual([]);
      expect(computer.remembered).toEqual([]);
    });

    it('asks even when the site was "always allowed", and logs the approval as once', async () => {
      store.rows.set('f2', autoEntry('f2', { policy: 'ask', always_origins: JSON.stringify([site.origin]) }));
      const { turn } = await botOn(`${site.origin}/login`, {}, async ({ browser }) => {
        await browser.run({ action: 'open', url: `${other.origin}/home` });
      });
      expect(await fillLogin(turn, { item_id: 'f2' }, computer.deps)).toMatchObject({ filled: true });
      expect(turn.requestApproval).toHaveBeenCalledTimes(1);
      expect(store.access[0]).toMatchObject({ outcome: 'filled', approval: 'once' });
    });

    it('asks after shell output, a file or a search (outside content with no origin)', async () => {
      store.rows.set('f3', autoEntry('f3'));
      const { turn, ledger } = await botOn(`${site.origin}/login`);
      noteTurnObservation(ledger, null, ledger.tainted); // what the computer tool records for shell / read_file
      await fillLogin(turn, { item_id: 'f3' }, computer.deps);
      expect(turn.requestApproval).toHaveBeenCalledTimes(1);
      expect(vi.mocked(turn.requestApproval).mock.calls[0]![0].details).toEqual(
        expect.arrayContaining([
          {
            label: 'Why you are asked',
            value: 'In this turn the Bot also read: command output, files or search results',
          },
        ]),
      );
    });

    it('asks when something else tainted the turn before its first page', async () => {
      store.rows.set('f4', autoEntry('f4'));
      const { turn } = await botOn(`${site.origin}/login`, {}, async ({ ledger }) => {
        ledger.tainted = true; // e.g. an external_search result earlier in the turn
      });
      await fillLogin(turn, { item_id: 'f4' }, computer.deps);
      expect(turn.requestApproval).toHaveBeenCalledTimes(1);
    });

    it("keeps auto fills card-free when the turn read only the entry's own site", async () => {
      store.rows.set('f5', autoEntry('f5'));
      const { turn } = await botOn(`${site.origin}/login`, {}, async ({ browser }) => {
        await browser.run({ action: 'open', url: `${site.origin}/home` });
      });
      expect(await fillLogin(turn, { item_id: 'f5', submit: true }, computer.deps)).toMatchObject({
        filled: true,
        submitted: true,
      });
      expect(turn.requestApproval).not.toHaveBeenCalled();
      expect(store.access[0]).toMatchObject({ approval: 'auto' });
    });
  });

  describe('take-over during a fill', () => {
    it('stops between the user name and the password when the member takes over (any API slot)', async () => {
      store.rows.set(
        't1',
        item('t1', [site.origin], { username: 'me@example.com', password: 'pw-t1' }, { policy: 'auto' }),
      );
      const implicitTakeover = vi.fn(async () => 'card' as const);
      const { turn, page } = await botOn(`${site.origin}/login`, { implicitTakeover });
      // The DB lease flips as soon as the user name is in: the take-over came
      // from another slot, so only the lease re-check before each field sees it.
      const deps = {
        ...computer.deps,
        currentLease: async () =>
          (await page().inputValue('input[name=login]'))
            ? { controller: 'user' as const, epoch: 1 }
            : { controller: 'bot' as const, epoch: 0 },
      };
      const result = await fillLogin(turn, { item_id: 't1', submit: true }, deps);
      expect(result).toMatchObject({ code: 'user_in_control' });
      // A card waits for the hand-back, naming the site the fill was on.
      expect(implicitTakeover).toHaveBeenCalledWith({ reason: 'interrupted', host: '127.0.0.1' });
      expect(await page().inputValue('input[name=login]')).toBe('me@example.com');
      expect(await page().inputValue('input[name=password]')).toBe('');
      expect(site.submissions).toEqual([]);
    });

    it('a take-over in this process ends a fill that waits on the approval card', async () => {
      store.rows.set('t2', item('t2', [site.origin], { username: 'me@example.com', password: 'pw-t2' }));
      let release: () => void = () => undefined;
      let notifyApproval: () => void = () => undefined;
      const approvalRequested = new Promise<void>((resolve) => {
        notifyApproval = resolve;
      });
      const { turn, page } = await botOn(`${site.origin}/login`, {
        requestApproval: vi.fn(
          () =>
            new Promise<'approve'>((resolve) => {
              release = () => resolve('approve');
              notifyApproval();
            }),
        ),
      });
      const filling = fillLogin(turn, { item_id: 't2' }, computer.deps);
      // Wait for the actual card boundary, not vi.waitFor's 1 s default: real
      // Chromium preflight can take longer on a busy host. Fail if it ends early.
      await Promise.race([
        approvalRequested,
        filling.then((result) => {
          throw new Error(`Fill ended before approval: ${JSON.stringify(result)}`);
        }),
      ]);
      // What takeoverComputer does: the lease goes to the member, then work in flight is aborted.
      computer.lease = { controller: 'user', epoch: 1 };
      expect(abortComputerActions(USER)).toBe(1);
      expect(await filling).toMatchObject({ code: 'user_in_control' });
      release(); // the card is answered late: nothing happens
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await page().inputValue('input[name=password]')).toBe('');
      expect(computer.remembered).toEqual([]);
    });
  });

  it('does not touch the page while the member holds the computer, and leaves a card for the hand-back', async () => {
    store.rows.set(
      'w1',
      item('w1', [site.origin], { username: 'me@example.com', password: 'pw-w1' }, { policy: 'auto' }),
    );
    const implicitTakeover = vi.fn(async () => 'card' as const);
    const { turn, page } = await botOn(`${site.origin}/login`, { implicitTakeover });
    computer.lease = { controller: 'user', epoch: 1 };
    const result = await fillLogin(turn, { item_id: 'w1', submit: true }, computer.deps);
    expect(result).toMatchObject({ code: 'user_in_control' });
    expect(String((result as { error: string }).error)).toMatch(/woken automatically/);
    expect(implicitTakeover).toHaveBeenCalledWith({ reason: 'waiting' });
    expect(await page().inputValue('input[name=login]')).toBe('');
    expect(computer.remembered).toEqual([]);
  });

  it('fills nothing when the member declines or the card expires', async () => {
    store.rows.set('v6', item('v6', [site.origin], { username: 'me@example.com', password: 'pw-6' }));
    for (const decision of ['deny', 'expired'] as const) {
      const { turn, page } = await botOn(`${site.origin}/login`, { requestApproval: vi.fn(async () => decision) });
      const result = await fillLogin(turn, { item_id: 'v6' }, computer.deps);
      expect(result).toMatchObject({ code: decision === 'deny' ? 'denied' : 'expired' });
      expect(await page().inputValue('input[name=password]')).toBe('');
    }
    expect(store.access.map((a) => a.outcome)).toEqual(['denied', 'denied']);
    expect(computer.remembered).toEqual([]);
  });

  it('refuses a page whose origin is not one of the entry sites — before asking anyone', async () => {
    store.rows.set('v7', item('v7', ['https://github.com'], { username: 'me', password: 'pw-7' }));
    const { turn } = await botOn(`${site.origin}/login`);
    const result = await fillLogin(turn, { item_id: 'v7' }, computer.deps);
    expect(result).toMatchObject({ code: 'origin_mismatch' });
    expect(turn.requestApproval).not.toHaveBeenCalled();
    expect(store.access[0]).toMatchObject({ outcome: 'origin_mismatch', origin: site.origin });
  });

  it('aborts when the page navigates to another site while waiting for approval', async () => {
    store.rows.set('v8', item('v8', [site.origin], { username: 'me@example.com', password: 'pw-8' }));
    let pageRef: () => import('playwright-core').Page = () => {
      throw new Error('unset');
    };
    const { turn, page } = await botOn(`${site.origin}/login`, {
      requestApproval: vi.fn(async () => {
        await pageRef().goto(`${other.origin}/login`);
        return 'approve' as const;
      }),
    });
    pageRef = page;
    const result = await fillLogin(turn, { item_id: 'v8', submit: true }, computer.deps);
    expect(result).toMatchObject({ code: 'page_changed' });
    expect(await page().inputValue('input[name=password]')).toBe('');
    expect(other.submissions).toEqual([]);
    expect(computer.remembered).toEqual([]);
  });

  it('aborts when the document changes on the same site while waiting (reload)', async () => {
    store.rows.set('v9', item('v9', [site.origin], { username: 'me@example.com', password: 'pw-9' }));
    let pageRef: () => import('playwright-core').Page = () => {
      throw new Error('unset');
    };
    const { turn, page } = await botOn(`${site.origin}/login`, {
      requestApproval: vi.fn(async () => {
        await pageRef().reload();
        return 'approve' as const;
      }),
    });
    pageRef = page;
    expect(await fillLogin(turn, { item_id: 'v9' }, computer.deps)).toMatchObject({ code: 'page_changed' });
  });

  it('never fills a field that lives in a frame of another site', async () => {
    store.rows.set(
      'v10',
      item('v10', [site.origin], { username: 'me@example.com', password: 'pw-10' }, { policy: 'auto' }),
    );
    const { turn, page } = await botOn(`${site.origin}/iframe-login`);
    await page().frameLocator('iframe').locator('input[type=password]').waitFor();
    const result = await fillLogin(turn, { item_id: 'v10' }, computer.deps);
    expect(result).toMatchObject({ code: 'no_fields' });
    expect(await page().frameLocator('iframe').locator('input[type=password]').inputValue()).toBe('');

    // Listing the embedded site on the entry makes the same fill legitimate.
    store.rows.set(
      'v11',
      item('v11', [site.origin, other.origin], { username: 'me@example.com', password: 'pw-11' }, { policy: 'auto' }),
    );
    expect(await fillLogin(turn, { item_id: 'v11' }, computer.deps)).toMatchObject({
      filled: true,
      fields: ['username', 'password'],
    });
    expect(await page().frameLocator('iframe').locator('input[type=password]').inputValue()).toBe('pw-11');
  });

  it('fills the user name alone on the first step of a two-step sign-in', async () => {
    store.rows.set(
      'v12',
      item('v12', [site.origin], { username: 'me@example.com', password: 'pw-12' }, { policy: 'auto' }),
    );
    const { turn } = await botOn(`${site.origin}/login-step1`);
    const result = await fillLogin(turn, { item_id: 'v12' }, computer.deps);
    expect(result).toMatchObject({ filled: true, fields: ['username'] });
    expect((result as { note: string }).note).toMatch(/password step/);
  });

  it('refuses while the member holds the computer, in background turns, and without a key', async () => {
    store.rows.set('v13', item('v13', [site.origin], { username: 'me', password: 'pw-13' }, { policy: 'auto' }));
    const { turn } = await botOn(`${site.origin}/login`);
    computer.lease = { controller: 'user', epoch: 1 };
    expect(await fillLogin(turn, { item_id: 'v13' }, computer.deps)).toMatchObject({ code: 'user_in_control' });
    computer.lease = { controller: 'bot', epoch: 1 };
    expect(await fillLogin({ ...turn, background: true }, { item_id: 'v13' }, computer.deps)).toMatchObject({
      code: 'not_allowed',
    });
    expect(await fillLogin(turn, { item_id: 'nope' }, computer.deps)).toMatchObject({ code: 'not_found' });
    delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    try {
      expect(await fillLogin(turn, { item_id: 'v13' }, computer.deps)).toMatchObject({ code: 'vault_unavailable' });
    } finally {
      process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
    }
  });

  describe('secure sign-in card', () => {
    it('fills what the member typed into the Bot page and submits', async () => {
      const { turn } = await botOn(`${site.origin}/login`);
      const result = await fillSecureLogin(
        {
          userId: USER,
          botId: turn.botId,
          sessionId: 's1',
          origin: site.origin,
          values: { username: 'typed@example.com', password: 'typed-pw' },
          submit: true,
        },
        computer.deps,
      );
      // The site's next screen asks for a code: reported, so the Bot raises the OTP card.
      expect(result).toEqual({ fields: ['username', 'password'], submitted: true, pending: [], next: 'otp' });
      expect(site.submissions[0]!.fields).toEqual({ login: 'typed@example.com', password: 'typed-pw' });
      expect(computer.remembered).toEqual(expect.arrayContaining(['typed@example.com', 'typed-pw']));
    });

    const secure = (botId: string, values: { username?: string; password?: string; otp?: string }) => ({
      userId: USER,
      botId,
      sessionId: 's1',
      origin: site.origin,
      values,
      submit: true,
    });

    it('follows a two-step sign-in to the password page, so the member types once', async () => {
      const { turn, page } = await botOn(`${site.origin}/login-step1`);
      const result = await fillSecureLogin(
        secure(turn.botId, { username: 'two@example.com', password: 'two-pw' }),
        computer.deps,
      );
      expect(result).toMatchObject({ fields: ['username', 'password'], submitted: true, pending: [] });
      expect(site.submissions.map((s) => s.path)).toEqual(['/step1', '/session']);
      expect(site.submissions[0]!.fields).toEqual({ identifier: 'two@example.com' });
      expect(site.submissions[1]!.fields).toEqual({ password: 'two-pw' });
      expect(new URL(page().url()).pathname).toBe('/otp');
    });

    it('follows a single-page two-step sign-in (the password appears on the same document)', async () => {
      const { turn } = await botOn(`${site.origin}/login-spa`);
      const result = await fillSecureLogin(
        secure(turn.botId, { username: 'spa@example.com', password: 'spa-pw' }),
        computer.deps,
      );
      expect(result).toMatchObject({ fields: ['username', 'password'], submitted: true, pending: [] });
      expect(site.submissions).toEqual([
        { path: '/session-spa', fields: { identifier: 'spa@example.com', password: 'spa-pw' } },
      ]);
    });

    it('reports the password as pending when the second step never comes', async () => {
      const { turn } = await botOn(`${site.origin}/login-dead-end`);
      const result = await fillSecureLogin(
        secure(turn.botId, { username: 'x@example.com', password: 'never-used' }),
        computer.deps,
        { nextStepWaitMs: 1_500 },
      );
      expect(result).toMatchObject({ fields: ['username'], submitted: true, pending: ['password'] });
      expect(JSON.stringify(site.submissions)).not.toContain('never-used');
    });

    it('takes a password alone (the second card of a two-step sign-in)', async () => {
      const { turn } = await botOn(`${site.origin}/login-step2`);
      const result = await fillSecureLogin(secure(turn.botId, { password: 'only-pw' }), computer.deps);
      expect(result).toMatchObject({ fields: ['password'], submitted: true, pending: [] });
      expect(site.submissions[0]).toEqual({ path: '/session', fields: { password: 'only-pw' } });
    });

    it('never follows the sign-in onto another site', async () => {
      site.pages.set(
        '/login-elsewhere',
        `<!doctype html><title>Sign in</title><form method="post" action="${other.origin}/step1"><label>Email <input type="email" name="identifier"></label><button>Next</button></form>`,
      );
      const { turn } = await botOn(`${site.origin}/login-elsewhere`);
      // Posts to the other site, which shows its own password page.
      const result = await fillSecureLogin(
        secure(turn.botId, { username: 'x@example.com', password: 'stay-pw' }),
        computer.deps,
        { nextStepWaitMs: 1_500 },
      );
      expect(result).toMatchObject({ fields: ['username'], pending: ['password'] });
      expect(other.submissions.map((s) => s.fields)).toEqual([{ identifier: 'x@example.com' }]);
    });

    it('refuses when the page moved to another site, or is gone', async () => {
      const { turn } = await botOn(`${other.origin}/login`);
      const args = {
        userId: USER,
        botId: turn.botId,
        sessionId: 's1',
        origin: site.origin,
        values: { password: 'typed-pw' },
        submit: true,
      };
      await expect(fillSecureLogin(args, computer.deps)).rejects.toMatchObject({ code: 'origin_mismatch' });
      await expect(fillSecureLogin({ ...args, botId: 'bot_without_tab' }, computer.deps)).rejects.toBeInstanceOf(
        SecureLoginError,
      );
      expect(other.submissions).toEqual([]);
    });
  });
});
