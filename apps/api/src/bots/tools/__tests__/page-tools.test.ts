/**
 * Tools whose output depends on the Bot's page: request_takeover (card
 * payload from the browser, not the model), vault list (site matching), the
 * page actions hover / drag / upload / wait, and the human-check hand-over
 * (the browser raises the verification card itself and ends the turn).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotRequestRow, DatabaseProvider, VaultItemRow } from '@greenhouse/db';
import {
  BrowserSession,
  CHALLENGE_TIMING,
  type ComputerTurn,
  type Observation,
  type ToolFailure,
} from '../../computer/browser-session.js';
import { leaseRegistryFor } from '../../computer/tab-leases.js';
import { computerTurnFrom } from '../../computer/tools.js';
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
import { testBot, testTurn } from '../../__tests__/helpers/turn.js';

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
    // The Bot's closing line must point at the fill-in card, not at a take-over.
    expect(result.message).toMatch(/fill in the card above/);
    expect(ctx.stopAfterStep).toHaveBeenCalledWith('takeover');
  });

  it('raises a take-over card for a CAPTCHA', async () => {
    const ctx = await botOnPage('/captcha');
    const result = await requestTakeover(ctx, { kind: 'captcha', reason: 'There is a CAPTCHA' }, computer.deps);
    expect(ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      { reason: 'There is a CAPTCHA', kind: 'captcha', url: `${site.origin}/captcha` },
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
    expect(result).toMatchObject({ card: 'take_over' });
    expect(result.message).not.toMatch(/fill in the card/);
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

// ─── Page actions: hover, drag, upload, wait ──────────────

const isFailure = (result: Observation | ToolFailure): result is ToolFailure => !('url' in result);

/** The ref of the first snapshot line matching `pattern`. */
const refOf = (snapshot: string, pattern: RegExp) => {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  return /\[ref=([^\]]+)\]/.exec(line ?? '')?.[1] ?? '';
};

const PAGES: Record<string, string> = {
  '/menu': `<!doctype html><title>Menu</title>
    <style>#menu{display:none} #wrap:hover #menu{display:block}</style>
    <div id="wrap"><button>Products</button><ul id="menu"><li><a href="/page2">Pricing</a></li></ul></div>`,
  '/board': `<!doctype html><title>Board</title>
    <div id="card" draggable="true" role="button" aria-label="Card A" style="width:120px;height:40px">Card A</div>
    <div id="done" role="region" aria-label="Done column" style="width:240px;height:120px;border:1px solid">Done</div>
    <p id="status">Card A is in To do</p>
    <script>
      const card = document.getElementById('card'), done = document.getElementById('done');
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'a'));
      done.addEventListener('dragover', (e) => e.preventDefault());
      done.addEventListener('drop', (e) => {
        e.preventDefault();
        document.getElementById('status').textContent = 'Card A is in Done';
      });
    </script>`,
  '/upload': `<!doctype html><title>Upload</title>
    <label>Attachment <input type="file" id="f"></label>
    <p id="out">no file yet</p>
    <button id="pick">Upload photo</button>
    <input type="file" id="hidden" style="display:none">
    <p id="out2">no photo yet</p>
    <button id="save">Save draft</button>
    <script>
      const show = (input, out) => input.addEventListener('change', () => {
        const f = input.files[0];
        document.getElementById(out).textContent = 'got ' + f.name + ' ' + f.size + ' bytes ' + f.type;
      });
      show(document.getElementById('f'), 'out');
      show(document.getElementById('hidden'), 'out2');
      document.getElementById('pick').addEventListener('click', () => document.getElementById('hidden').click());
    </script>`,
  '/later': `<!doctype html><title>Report</title><p id="s">Preparing the report…</p>
    <script>setTimeout(() => { document.getElementById('s').textContent = 'Report ready'; }, 600);</script>`,
  // A "checking your browser" interstitial that clears by itself, like most do.
  '/challenge-clears': `<!doctype html><title>Just a moment...</title><p>Checking your browser before accessing the site.</p>
    <script>setTimeout(() => location.replace('/home'), 700);</script>`,
};

describe.skipIf(!chromiumAvailable())('page actions and human checks on a real page', { timeout: 90_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;
  /** A Cloudflare-style challenge on another origin: 403 + cf-mitigated, a title the DOM sniff does not know. */
  let cloudflare: Server;
  let cloudflareOrigin: string;
  let n = 0;
  const timing = { ...CHALLENGE_TIMING };

  beforeAll(async () => {
    site = await startFixtureSite();
    for (const [path, html] of Object.entries(PAGES)) site.pages.set(path, html);
    cloudflare = createServer((_req, res) => {
      res.writeHead(403, {
        'content-type': 'text/html; charset=utf-8',
        'cf-mitigated': 'challenge',
        server: 'cloudflare',
      });
      res.end('<!doctype html><title>Un instant…</title><p>Vérification en cours</p>');
    });
    await new Promise<void>((resolve) => cloudflare.listen(0, '127.0.0.1', resolve));
    cloudflareOrigin = `http://127.0.0.1:${(cloudflare.address() as AddressInfo).port}`;
    chromium = await launchTestChromium();
    // Seconds, not the production 6 s: the clearing page above clears in 0.7 s.
    Object.assign(CHALLENGE_TIMING, { settleMs: 2_500, recheckMs: 250 });
  });
  afterAll(async () => {
    Object.assign(CHALLENGE_TIMING, timing);
    await chromium?.close();
    await site?.close();
    cloudflare?.closeAllConnections();
    await new Promise<void>((resolve) => (cloudflare ? cloudflare.close(() => resolve()) : resolve()));
  });
  afterEach(async () => {
    const registry = leaseRegistryFor(chromium.browser);
    for (const lease of registry.list()) await registry.release(lease.key);
  });

  /** A Bot turn wired like production (computerTurnFrom): spies on cards and the turn's end. */
  function botTurn(
    opts: { background?: boolean; locale?: 'en' | 'zh' } = {},
    overrides: Parameters<typeof fakeComputer>[1] = {},
  ) {
    const computer: FakeComputer = fakeComputer(chromium.browser, overrides);
    const listRequests = vi.fn(async (): Promise<BotRequestRow[]> => []);
    const ctx = testTurn({
      db: { bots: { listRequests } } as unknown as DatabaseProvider,
      bot: testBot(`bot_page_action_${++n}`),
      sessionId: `sess_page_${n}`,
      turnId: `run_page:${n}`,
      background: opts.background ?? false,
      ...(opts.locale ? { locale: opts.locale } : {}),
    });
    const turn: ComputerTurn = computerTurnFrom(ctx, computer.deps);
    const act = (input: Parameters<BrowserSession['run']>[0]) => new BrowserSession(turn, computer.deps).run(input);
    return { ctx, turn, computer, act, listRequests };
  }

  it('hover reveals what the page shows on hover', async () => {
    const { act } = botTurn();
    const page = (await act({ action: 'open', url: `${site.origin}/menu` })) as Observation;
    expect(page.snapshot).not.toContain('Pricing');
    const hovered = (await act({ action: 'hover', ref: refOf(page.snapshot, /button "Products"/) })) as Observation;
    expect(hovered.snapshot).toMatch(/link "Pricing"/);
    expect(await act({ action: 'hover', ref: 'e999' })).toMatchObject({ code: 'stale_ref' });
  });

  it('drag drops one element onto another', async () => {
    const { act } = botTurn();
    const page = (await act({ action: 'open', url: `${site.origin}/board` })) as Observation;
    expect(await act({ action: 'drag', ref: refOf(page.snapshot, /button "Card A"/) })).toMatchObject({
      code: 'invalid',
    });
    const dropped = (await act({
      action: 'drag',
      ref: refOf(page.snapshot, /button "Card A"/),
      to_ref: refOf(page.snapshot, /region "Done column"/),
    })) as Observation;
    expect(isFailure(dropped)).toBe(false);
    expect(dropped.snapshot).toContain('Card A is in Done');
  });

  it('upload puts a file from the agent home into a file input, or answers the picker a button opens', async () => {
    const readFile = vi.fn(async () => Buffer.from('%PDF-1.7 test'));
    const { act } = botTurn({}, { readFile });
    const page = (await act({ action: 'open', url: `${site.origin}/upload` })) as Observation;
    const direct = (await act({
      action: 'upload',
      ref: refOf(page.snapshot, /button "Attachment"/),
      path: 'reports/Q3 报告.pdf',
    })) as Observation;
    expect(readFile).toHaveBeenCalledWith(
      'u1',
      '/home/agent/work/reports/Q3 报告.pdf',
      expect.objectContaining({ maxBytes: 20 * 1024 * 1024 + 1, signal: expect.any(AbortSignal) }),
    );
    expect(direct.snapshot).toContain('got Q3 报告.pdf 13 bytes application/pdf');

    const viaButton = (await act({
      action: 'upload',
      ref: refOf(page.snapshot, /button "Upload photo"/),
      path: '~/Downloads/cat.png',
    })) as Observation;
    expect(viaButton.snapshot).toContain('got cat.png 13 bytes image/png');

    // A button that opens no picker: the click happened, so the page is shown with the error.
    const notAFileInput = (await act({
      action: 'upload',
      ref: refOf(page.snapshot, /button "Save draft"/),
      path: 'a.txt',
    })) as Observation;
    expect(notAFileInput).toMatchObject({ code: 'not_a_file_input', title: 'Upload' });
    expect(notAFileInput.error).toMatch(/did not open a file picker/);
  });

  it('upload refuses files outside the agent home, missing paths and files over 20 MB', async () => {
    const big = botTurn({}, { readFile: vi.fn(async () => Buffer.alloc(20 * 1024 * 1024 + 1)) });
    const page = (await big.act({ action: 'open', url: `${site.origin}/upload` })) as Observation;
    const ref = refOf(page.snapshot, /button "Attachment"/);
    expect(await big.act({ action: 'upload', ref, path: 'huge.zip' })).toMatchObject({ code: 'too_large' });
    expect(await big.act({ action: 'upload', ref, path: '/etc/passwd' })).toMatchObject({ code: 'forbidden_path' });
    expect(await big.act({ action: 'upload', ref, path: '/home/browser/chromium/Cookies' })).toMatchObject({
      code: 'forbidden_path',
    });
    expect(await big.act({ action: 'upload', ref })).toMatchObject({ code: 'invalid' });
    const { ComputerDockerError } = await import('../../computer/docker.js');
    const missing = botTurn(
      {},
      {
        readFile: vi.fn(async () => {
          throw new ComputerDockerError('failed', 'not a regular file: /home/agent/work/nope.pdf');
        }),
      },
    );
    await missing.act({ action: 'open', url: `${site.origin}/upload` });
    const failed = await missing.act({ action: 'upload', ref, path: 'nope.pdf' });
    expect(failed).toMatchObject({ code: 'file_unreadable' });
    expect(String((failed as ToolFailure).error)).toMatch(/not a regular file/);
  });

  it('wait returns once the text shows, or says it did not and shows the page as it is', async () => {
    const { act } = botTurn();
    await act({ action: 'open', url: `${site.origin}/later` });
    const ready = (await act({ action: 'wait', text: 'Report ready', timeout_s: 10 })) as Observation;
    expect(ready.snapshot).toContain('Report ready');
    expect(ready.code).toBeUndefined();
    const started = Date.now();
    const never = (await act({ action: 'wait', text: 'Never appears', timeout_s: 1 })) as Observation;
    expect(never).toMatchObject({ code: 'wait_timeout' });
    expect(never.error).toMatch(/"Never appears" did not appear within 1 s/);
    expect(never.snapshot).toContain('Report ready');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await act({ action: 'wait', timeout_s: 1 })).toMatchObject({ title: 'Report' });
  });

  it('a stopped turn stops waiting at once', async () => {
    const stop = new AbortController();
    const { turn, computer } = botTurn();
    const stoppable: ComputerTurn = { ...turn, signal: stop.signal };
    await new BrowserSession(stoppable, computer.deps).run({ action: 'open', url: `${site.origin}/page2` });
    const waiting = new BrowserSession(stoppable, computer.deps).run({ action: 'wait', timeout_s: 30 });
    const started = Date.now();
    setTimeout(() => stop.abort(), 200);
    expect(await waiting).toMatchObject({ code: 'aborted' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a background task may wait, but never hover, drag or upload', async () => {
    const { act } = botTurn({ background: true });
    await act({ action: 'open', url: `${site.origin}/later` });
    expect(await act({ action: 'wait', text: 'Report ready', timeout_s: 5 })).toMatchObject({ title: 'Report' });
    for (const action of ['hover', 'drag', 'upload'] as const) {
      expect(await act({ action, ref: 'e1', to_ref: 'e2', path: 'a.pdf' })).toMatchObject({ code: 'not_allowed' });
    }
  });

  // ─── Human checks ───

  it('a CAPTCHA raises one verification card, ends the turn, and the site is not opened again this turn', async () => {
    const { ctx, act, listRequests } = botTurn();
    const blocked = (await act({ action: 'open', url: `${site.origin}/captcha?ticket=secret#x` })) as Observation;
    expect(blocked).toMatchObject({ blocked: 'human_check', title: 'Security check' });
    expect(blocked.hint).toMatch(/member now has a card.*End your turn NOW/);
    expect(blocked.hint).toMatch(/do not try another address on this site or reach it with the shell or a search/);
    expect(listRequests).toHaveBeenCalledWith('u1', {
      sessionId: ctx.sessionId,
      status: 'pending',
      kinds: ['takeover'],
    });
    expect(ctx.createRequest).toHaveBeenCalledTimes(1);
    expect(ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      {
        kind: 'captcha',
        reason: '127.0.0.1 asks for human verification — please complete it on the computer',
        url: `${site.origin}/captcha`, // origin + path only: no query, no fragment
      },
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
    expect(ctx.stopAfterStep).toHaveBeenCalledWith('takeover');

    // The URL-hopping a model tries next is refused before anything loads.
    const again = await act({ action: 'open', url: `${site.origin}/home` });
    expect(again).toMatchObject({ code: 'human_check' });
    expect((again as ToolFailure).error).toMatch(/waiting for the member.*Do not try other addresses on this site/);
    expect(ctx.createRequest).toHaveBeenCalledTimes(1);
    // Another site is not refused.
    expect(await act({ action: 'open', url: `${site.origin.replace('127.0.0.1', 'localhost')}/home` })).toMatchObject({
      title: 'Dashboard',
    });
  });

  it('parallel calls that hit the check share one card; a pending card of this Bot is reused', async () => {
    const parallel = botTurn();
    const results = await Promise.all([
      parallel.act({ action: 'open', url: `${site.origin}/captcha` }),
      parallel.act({ action: 'open', url: `${site.origin}/captcha-invisible` }),
    ]);
    expect(parallel.ctx.createRequest).toHaveBeenCalledTimes(1);
    // The call queued behind the check is refused at its real start, not opened.
    expect(results.map((r) => ('blocked' in r ? r.blocked : r.code))).toEqual(['human_check', 'human_check']);
    expect(results[1]).toMatchObject({ code: 'human_check' });

    const pending = botTurn();
    pending.listRequests.mockResolvedValue([{ id: 'brq_old', bot_id: pending.ctx.bot.id, kind: 'takeover' }] as never);
    const result = (await pending.act({ action: 'open', url: `${site.origin}/captcha` })) as Observation;
    expect(result.blocked).toBe('human_check');
    expect(result.hint).toMatch(/member now has a card/);
    expect(pending.ctx.createRequest).not.toHaveBeenCalled();
    expect(pending.ctx.stopAfterStep).toHaveBeenCalledWith('takeover');
  });

  it('a challenge page that clears by itself is waited out, with no card', async () => {
    const { ctx, act } = botTurn();
    const result = (await act({ action: 'open', url: `${site.origin}/challenge-clears` })) as Observation;
    expect(result).toMatchObject({ url: `${site.origin}/home`, title: 'Dashboard' });
    expect(result.blocked).toBeUndefined();
    expect(result.snapshot).toContain('Welcome back');
    expect(ctx.createRequest).not.toHaveBeenCalled();
    expect(ctx.stopAfterStep).not.toHaveBeenCalled();
  });

  it('a challenge page that stays, or a Cloudflare challenge response, is handed over', async () => {
    const stays = botTurn({ locale: 'zh' });
    const started = Date.now();
    const result = (await stays.act({ action: 'open', url: `${site.origin}/challenge` })) as Observation;
    expect(Date.now() - started).toBeGreaterThanOrEqual(CHALLENGE_TIMING.settleMs - 50);
    expect(result.blocked).toBe('human_check');
    expect(stays.ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      expect.objectContaining({ kind: 'captcha', reason: '127.0.0.1 要求人机验证，请在电脑上完成验证' }),
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );

    const cf = botTurn();
    const blocked = (await cf.act({ action: 'open', url: `${cloudflareOrigin}/login` })) as Observation;
    expect(blocked).toMatchObject({ blocked: 'human_check', title: 'Un instant…' });
    expect(cf.ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      expect.objectContaining({ kind: 'captcha', url: `${cloudflareOrigin}/login` }),
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
    expect(cf.ctx.stopAfterStep).toHaveBeenCalledWith('takeover');
  });

  it('a background task gets no card: it notes the check and moves on, and does not retry the site', async () => {
    const { ctx, act } = botTurn({ background: true });
    const result = (await act({ action: 'open', url: `${site.origin}/captcha` })) as Observation;
    expect(result.blocked).toBe('human_check');
    expect(result.hint).toMatch(/background task cannot pass — note it in your report and move on/);
    expect(ctx.createRequest).not.toHaveBeenCalled();
    expect(ctx.stopAfterStep).not.toHaveBeenCalled();
    expect(await act({ action: 'open', url: `${site.origin}/home` })).toMatchObject({ code: 'human_check' });
  });

  it('without a card (it could not be raised) the Bot is told to ask for one itself', async () => {
    const { ctx, act } = botTurn();
    vi.mocked(ctx.createRequest).mockRejectedValueOnce(new Error('db down'));
    const result = (await act({ action: 'open', url: `${site.origin}/captcha` })) as Observation;
    expect(result.blocked).toBe('human_check');
    expect(result.hint).toMatch(/call request_takeover with kind "captcha"/);
    expect(result.hint).not.toMatch(/member now has a card/);
  });
});
