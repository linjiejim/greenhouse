/**
 * buildComputerTools (which tools a turn gets) and handleLoginDecision (the
 * secure sign-in card, end to end on a real page).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotRequestRow, DatabaseProvider, VaultItemRow } from '@greenhouse/db';
import type { ZodType } from 'zod';
import type { Tool } from 'ai';
import {
  chromiumAvailable,
  fakeComputer,
  launchTestChromium,
  type FakeComputer,
  type TestChromium,
} from '../../__tests__/helpers/chromium.js';
import { startFixtureSite, type FixtureSite } from '../../__tests__/helpers/fixture-server.js';
import { testTurn } from '../../__tests__/helpers/turn.js';

const runtime = vi.hoisted(() => ({ state: 'ready' as string }));
vi.mock('../runtime.js', () => ({
  getComputerRuntime: () => ({ state: runtime.state, reason: null, hardened: false }),
  computerStatusFor: vi.fn(),
}));

const { buildComputerTools, computerTurnFrom, describeSecureLogin, handleLoginDecision, SecureLoginError } =
  await import('../tools.js');
const { BrowserSession } = await import('../browser-session.js');
const { leaseRegistryFor } = await import('../tab-leases.js');

const KEY = 'd4'.repeat(32);
const originalKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;

function schemaOf(tool: Tool): ZodType {
  return tool.inputSchema as unknown as ZodType;
}

describe('buildComputerTools', () => {
  beforeEach(() => {
    runtime.state = 'ready';
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    else process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it('offers nothing when the computer runtime is not ready', () => {
    for (const state of ['disabled', 'checking', 'unavailable']) {
      runtime.state = state;
      expect(buildComputerTools(testTurn())).toEqual({});
    }
  });

  it('gives foreground turns browser, computer, take-over and vault', () => {
    expect(Object.keys(buildComputerTools(testTurn())).sort()).toEqual([
      'browser',
      'computer',
      'request_takeover',
      'vault',
    ]);
  });

  it('leaves the vault out when it is not configured', () => {
    delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    expect(Object.keys(buildComputerTools(testTurn())).sort()).toEqual(['browser', 'computer', 'request_takeover']);
  });

  it('gives background turns a read-only browser and computer only', () => {
    const tools = buildComputerTools(testTurn({ background: true, userTriggered: false }));
    expect(Object.keys(tools).sort()).toEqual(['browser', 'computer']);
    const browser = schemaOf(tools.browser!);
    expect(browser.safeParse({ action: 'open', url: 'https://example.com' }).success).toBe(true);
    for (const action of ['click', 'type', 'select', 'press', 'close']) {
      expect(browser.safeParse({ action, ref: 'e1' }).success).toBe(false);
    }
    expect(browser.safeParse({ action: 'wait', text: 'Results', timeout_s: 10 }).success).toBe(true);
    for (const action of ['hover', 'drag', 'upload']) {
      expect(browser.safeParse({ action, ref: 'e1', to_ref: 'e2', path: 'a.pdf' }).success).toBe(false);
    }
    const computer = schemaOf(tools.computer!);
    expect(computer.safeParse({ action: 'read_file', path: 'a' }).success).toBe(true);
    expect(computer.safeParse({ action: 'process_log', id: 'j0000beef' }).success).toBe(true);
    expect(computer.safeParse({ action: 'shell', command: 'ls' }).success).toBe(false);
    expect(computer.safeParse({ action: 'run_background', command: 'make' }).success).toBe(false);
    expect(tools.browser!.description).toMatch(/background task only open, snapshot/);
  });

  it('offers the new page actions to foreground turns, with bounded inputs', () => {
    const browser = schemaOf(buildComputerTools(testTurn()).browser!);
    expect(browser.safeParse({ action: 'drag', ref: 'e1', to_ref: 'e2' }).success).toBe(true);
    expect(browser.safeParse({ action: 'upload', ref: 'e1', path: '~/Downloads/a.pdf' }).success).toBe(true);
    expect(browser.safeParse({ action: 'hover', ref: 'e1' }).success).toBe(true);
    expect(browser.safeParse({ action: 'wait', timeout_s: 31 }).success).toBe(false);
  });

  it('wires the verification card into foreground turns only', () => {
    expect(computerTurnFrom(testTurn()).humanCheck).toBeTypeOf('function');
    expect(computerTurnFrom(testTurn({ background: true, userTriggered: false })).humanCheck).toBeUndefined();
  });
});

// ─── Secure sign-in ───────────────────────────────────────

/**
 * `computer` = the member's bot_computers row as handleLoginDecision reads it
 * (default: running since before any card of these tests).
 */
function memoryDb(
  locale: 'en' | 'zh',
  computer: { state: string; last_started_at: string | null } = {
    state: 'running',
    last_started_at: '2026-01-01T00:00:00.000Z',
  },
) {
  const rows = new Map<string, VaultItemRow>();
  const access: Array<Record<string, unknown>> = [];
  // bot_requests settle by compare-and-set on status 'pending', like the service.
  const requests = new Map<string, { status: string; result: Record<string, unknown> | null }>();
  const db = {
    users: { getById: async () => ({ id: 'u1', locale }) },
    botComputers: { get: async () => ({ user_id: 'u1', ...computer }) },
    bots: {
      settleRequest: vi.fn(async (_userId: string, id: string, status: string, result?: Record<string, unknown>) => {
        const current = requests.get(id);
        if (current && current.status !== 'pending') return undefined;
        requests.set(id, { status, result: result ?? null });
        return { id, status } as unknown as BotRequestRow;
      }),
    },
    vault: {
      list: async (userId: string) => [...rows.values()].filter((r) => r.user_id === userId),
      get: async (userId: string, id: string) => (rows.get(id)?.user_id === userId ? rows.get(id) : undefined),
      create: async (input: Record<string, unknown>) => {
        const now = new Date().toISOString();
        const row = {
          ...input,
          origins: JSON.stringify(input.origins),
          always_origins: '[]',
          last_used_at: null,
          created_at: now,
          updated_at: now,
        } as unknown as VaultItemRow;
        rows.set(row.id, row);
        return row;
      },
      update: async (userId: string, id: string, patch: Record<string, unknown>) => {
        const row = rows.get(id);
        if (!row) return undefined;
        const next = { ...row, ...patch } as VaultItemRow;
        rows.set(id, next);
        return next;
      },
      logAccess: async (row: Record<string, unknown>) => {
        access.push(row);
      },
    },
  };
  return { db: db as unknown as DatabaseProvider, rows, access, requests, settleRequest: db.bots.settleRequest };
}

describe.skipIf(!chromiumAvailable())('handleLoginDecision', { timeout: 90_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;
  let computer: FakeComputer;
  let n = 0;

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
    site.submissions.length = 0;
  });
  afterEach(async () => {
    const registry = leaseRegistryFor(chromium.browser);
    for (const lease of registry.list()) await registry.release(lease.key);
  });

  async function loginRequest(path = '/login'): Promise<BotRequestRow> {
    const botId = `bot_login_${++n}`;
    const turn = testTurn();
    await new BrowserSession(
      {
        db: turn.db,
        userId: 'u1',
        botId,
        sessionId: 'sess_1',
        turnId: 't',
        background: false,
        signal: turn.signal,
        markTainted: () => undefined,
        noteObservation: () => undefined,
        vaultMatches: null,
      },
      computer.deps,
    ).run({ action: 'open', url: `${site.origin}${path}` });
    const now = new Date().toISOString();
    return {
      id: `brq_login_${n}`,
      user_id: 'u1',
      session_id: 'sess_1',
      bot_id: botId,
      kind: 'login',
      status: 'pending',
      payload: JSON.stringify({
        reason: 'Sign in please',
        kind: 'login',
        origin: site.origin,
        url: `${site.origin}/login`,
        vault_matches: [],
      }),
      result: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
    };
  }

  it('fills, submits, logs, settles and only then wakes the Bot (values never leave the call)', async () => {
    const request = await loginRequest();
    const { db, access, requests, settleRequest } = memoryDb('zh');
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => {
      // Settled before the wake-up, so a second click or slot cannot wake it twice.
      expect(requests.get(request.id)?.status).toBe('resolved');
    });

    await handleLoginDecision(
      {
        userId: 'u1',
        request,
        decision: { decision: 'approve', login: { username: 'card@example.com', password: 'card-pw-1' } },
      },
      computer.deps,
      deliver,
      db,
    );

    expect(site.submissions[0]!.fields).toEqual({ login: 'card@example.com', password: 'card-pw-1' });
    expect(access[0]).toMatchObject({ action: 'secure_login', outcome: 'filled', approval: 'user', item_id: null });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [sessionId, item] = deliver.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(sessionId).toBe('sess_1');
    expect(item).toMatchObject({
      kind: 'continue',
      botId: request.bot_id,
      event: { kind: 'login_done', request_id: request.id, origin: site.origin, saved_to_vault: false },
    });
    // /login posts to /session, which asks for a code: the Bot is told to raise the OTP card.
    expect(String(item.eventText)).toMatch(/^已提交 127\.0\.0\.1 的登录，网站还需要一次性验证码/);
    expect(String(item.note)).toMatch(/one-time code.*request_takeover with kind "otp"/);
    expect(JSON.stringify(item)).not.toMatch(/card-pw-1|card@example\.com/);
    expect(JSON.stringify(access)).not.toMatch(/card-pw-1/);
    expect(settleRequest).toHaveBeenCalledWith('u1', request.id, 'resolved', {
      decision: 'approve',
      by: 'member',
      fields: ['username', 'password'],
    });
    expect(JSON.stringify(settleRequest.mock.calls)).not.toMatch(/card-pw-1|card@example\.com/);
  });

  it('follows a two-step sign-in and reports a real sign-in to the Bot', async () => {
    const request = await loginRequest('/login-spa');
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => undefined);
    await handleLoginDecision(
      {
        userId: 'u1',
        request,
        decision: { decision: 'approve', login: { username: 'spa@example.com', password: 'spa-pw' } },
      },
      computer.deps,
      deliver,
      memoryDb('en').db,
    );
    expect(site.submissions).toEqual([
      { path: '/session-spa', fields: { identifier: 'spa@example.com', password: 'spa-pw' } },
    ]);
    const item = deliver.mock.calls[0]![1] as { note: string; eventText: string };
    expect(item.eventText).toBe('Signed in to 127.0.0.1 with the secure sign-in card');
    expect(item.note).toMatch(/signed in on .* and submitted the form/);
  });

  it('saves to the vault when asked, and updates instead of duplicating next time', async () => {
    const { db, rows } = memoryDb('en');
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => undefined);
    const decide = async (password: string) =>
      handleLoginDecision(
        {
          userId: 'u1',
          request: await loginRequest(),
          decision: {
            decision: 'approve',
            login: { username: 'save@example.com', password, save_to_vault: true, submit: false },
          },
        },
        computer.deps,
        deliver,
        db,
      );
    await decide('first-pw');
    expect(rows.size).toBe(1);
    const saved = [...rows.values()][0]!;
    expect(saved).toMatchObject({ label: '127.0.0.1', username_hint: 'sa***@example.com' });
    expect(JSON.parse(saved.origins)).toEqual([site.origin]);
    expect(saved.password_enc).not.toContain('first-pw');
    expect(site.submissions).toEqual([]); // submit: false

    await decide('second-pw');
    expect(rows.size).toBe(1);
    const second = deliver.mock.calls[1]![1] as { eventText: string };
    expect(second).toMatchObject({ event: { saved_to_vault: true } });
    expect(second.eventText).toMatch(/saved it to Passwords/);
  });

  it('"Not now" settles the card, writes a transcript line and wakes the Bot — once', async () => {
    const request = await loginRequest();
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => undefined);
    const { db, requests } = memoryDb('en');
    const deny = () =>
      handleLoginDecision({ userId: 'u1', request, decision: { decision: 'deny' } }, computer.deps, deliver, db);
    await deny();
    expect(requests.get(request.id)).toEqual({ status: 'denied', result: { decision: 'deny', by: 'member' } });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![1]).toMatchObject({
      kind: 'continue',
      botId: request.bot_id,
      eventText: 'Sign-in to 127.0.0.1 skipped',
      event: { kind: 'request', request_kind: 'login', request_id: request.id, bot_id: request.bot_id },
    });
    expect(String((deliver.mock.calls[0]![1] as { note: string }).note)).toMatch(/chose not to sign in/);
    // A second click (or the other API slot) finds it settled: no second wake-up.
    await deny();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(site.submissions).toEqual([]);
  });

  it('a "Not now" whose wake-up fails still settles (the card does not error)', async () => {
    const request = await loginRequest();
    const { db, requests } = memoryDb('zh');
    const deliver = vi.fn(async () => {
      throw new Error('inbox down');
    });
    await handleLoginDecision({ userId: 'u1', request, decision: { decision: 'deny' } }, computer.deps, deliver, db);
    expect(requests.get(request.id)?.status).toBe('denied');
    expect(deliver.mock.calls.length).toBe(1);
  });

  it('refuses when the page left the asked-for site, and does not wake the Bot', async () => {
    const request = await loginRequest();
    const page = leaseRegistryFor(chromium.browser)
      .get({ kind: 'foreground', botId: request.bot_id!, sessionId: 'sess_1' })!
      .currentPage()!;
    await page.goto('about:blank');
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => undefined);
    await expect(
      handleLoginDecision(
        { userId: 'u1', request, decision: { decision: 'approve', login: { password: 'x' } } },
        computer.deps,
        deliver,
        memoryDb('en').db,
      ),
    ).rejects.toBeInstanceOf(SecureLoginError);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reopens the card's page in the Bot's tab when it is gone (the computer restarted), then fills it", async () => {
    const request = await loginRequest();
    // The computer was stopped and started again: the Bot's window is gone.
    await leaseRegistryFor(chromium.browser).release(`fg:${request.bot_id}:sess_1`);
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => undefined);
    await handleLoginDecision(
      {
        userId: 'u1',
        request,
        decision: { decision: 'approve', login: { username: 'back@example.com', password: 'back-pw' } },
      },
      computer.deps,
      deliver,
      memoryDb('en', { state: 'running', last_started_at: new Date(Date.now() + 1_000).toISOString() }).db,
    );
    expect(site.submissions[0]!.fields).toEqual({ login: 'back@example.com', password: 'back-pw' });
    const lease = leaseRegistryFor(chromium.browser).get({
      kind: 'foreground',
      botId: request.bot_id!,
      sessionId: 'sess_1',
    });
    expect(lease?.currentPage()?.url()).toMatch(new RegExp(`^${site.origin}/`));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('without a page to reopen, says whether the computer restarted (computer_restarted) or the page is just gone', async () => {
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => undefined);
    const noUrl = async () => {
      const request = await loginRequest();
      await leaseRegistryFor(chromium.browser).release(`fg:${request.bot_id}:sess_1`);
      const payload = JSON.parse(request.payload) as Record<string, unknown>;
      return { ...request, payload: JSON.stringify({ ...payload, url: null }) };
    };
    const decide = async (request: BotRequestRow, computerRow: { state: string; last_started_at: string | null }) =>
      handleLoginDecision(
        { userId: 'u1', request, decision: { decision: 'approve', login: { password: 'x' } } },
        computer.deps,
        deliver,
        memoryDb('en', computerRow).db,
      );
    const later = new Date(Date.now() + 60_000).toISOString();
    await expect(decide(await noUrl(), { state: 'running', last_started_at: later })).rejects.toMatchObject({
      code: 'computer_restarted',
    });
    await expect(decide(await noUrl(), { state: 'absent', last_started_at: null })).rejects.toMatchObject({
      code: 'computer_restarted',
    });
    await expect(
      decide(await noUrl(), { state: 'running', last_started_at: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'page_gone' });
    expect(deliver).not.toHaveBeenCalled();
    expect(site.submissions).toEqual([]);
  });

  it('rejects an empty card and leaves requests of other members alone', async () => {
    const request = await loginRequest();
    const deliver = vi.fn(async (_sessionId: string, _item: unknown) => undefined);
    await expect(
      handleLoginDecision(
        { userId: 'u1', request, decision: { decision: 'approve', login: {} } },
        computer.deps,
        deliver,
        memoryDb('en').db,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    // Someone else's request is not ours to settle.
    await handleLoginDecision(
      { userId: 'u2', request, decision: { decision: 'approve', login: { password: 'x' } } },
      computer.deps,
      deliver,
      memoryDb('en').db,
    );
    await handleLoginDecision(
      { userId: 'u2', request, decision: { decision: 'deny' } },
      computer.deps,
      deliver,
      memoryDb('en').db,
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(site.submissions).toEqual([]);
  });
});

describe('describeSecureLogin (what the Bot and the member are told)', () => {
  const base = { fields: ['username', 'password'] as Array<'username' | 'password' | 'otp'>, submitted: true };

  it('never claims a sign-in when the password had nowhere to go (two-step, second screen missing)', () => {
    const outcome = describeSecureLogin(
      { fields: ['username'], submitted: true, pending: ['password'], next: null },
      'https://accounts.example.com',
      null,
      false,
    );
    expect(outcome.eventText).toBe('Entered your user name on accounts.example.com; the password step is next');
    expect(outcome.note).toMatch(/password they typed was NOT used/);
    expect(outcome.note).toMatch(/request_takeover with kind "login" again/);
    expect(outcome.note).not.toMatch(/signed in on/);
    const saved = describeSecureLogin(
      { fields: ['username'], submitted: true, pending: ['password'], next: null },
      'https://accounts.example.com',
      { id: 'vlt_1', label: 'Example' },
      true,
    );
    expect(saved.note).toMatch(/vault fill_login with item vlt_1/);
    expect(saved.eventText).toBe('已在 accounts.example.com 填入用户名，下一步还需要输入密码，并保存到密码库');
  });

  it('a user name alone (second card to follow) is not reported as a sign-in either', () => {
    const outcome = describeSecureLogin(
      { fields: ['username'], submitted: true, pending: [], next: 'login' },
      'https://accounts.example.com',
      null,
      false,
    );
    expect(outcome.eventText).toBe('Entered your user name on accounts.example.com; the password step is next');
    expect(outcome.note).toMatch(/gave no password and the site now asks for one/);
  });

  it('points the Bot at the OTP card or the CAPTCHA take-over when the site asks for one', () => {
    expect(describeSecureLogin({ ...base, pending: [], next: 'otp' }, 'https://x.com', null, false).note).toMatch(
      /vault fill_totp .* request_takeover with kind "otp"/,
    );
    expect(describeSecureLogin({ ...base, pending: [], next: 'challenge' }, 'https://x.com', null, false).note).toMatch(
      /kind "captcha"/,
    );
  });

  it('reports a plain sign-in, and flags a sign-in page that is still showing', () => {
    const ok = describeSecureLogin({ ...base, pending: [], next: null }, 'https://x.com', null, false);
    expect(ok.eventText).toBe('Signed in to x.com with the secure sign-in card');
    expect(ok.note).toMatch(/Take a snapshot and continue/);
    expect(describeSecureLogin({ ...base, pending: [], next: 'login' }, 'https://x.com', null, false).note).toMatch(
      /still be asking to sign in/,
    );
  });
});
