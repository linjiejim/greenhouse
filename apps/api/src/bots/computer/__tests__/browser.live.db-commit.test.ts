/**
 * Live verification of the browser + vault layer on a real computer container
 * — skipped unless BOTS_LIVE=1. Production code path end to end: the Bot's
 * shell starts a small sign-in site INSIDE the computer (so the vault origin
 * is http://127.0.0.1:8765, allowed on development runtimes), then the
 * headful Chromium behind the DevTools relay opens it through tab leases,
 * snapshots are masked, the vault fills a login and a TOTP code, and the site
 * records what it received.
 *
 *   BOTS_LIVE=1 NODE_ENV=development BOTS_COMPUTER_ENABLED=1 \
 *   BOTS_COMPUTER_ALLOW_UNHARDENED=1 BOTS_COMPUTER_RUNTIME=runc \
 *   TEST_DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test \
 *   npx vitest run --project db-commit apps/api/src/bots/computer/__tests__/browser.live.db-commit.test.ts
 *
 * Needs the image (bash scripts/build-bot-computer.sh).
 *
 * @db-commit-reason one real computer (container, volume, browser profile)
 * spans every test, and the computer runtime's controller, timers and the
 * DevTools-owner lock read committed `bot_computers` rows and hold their own
 * connections outside any test transaction; Docker side effects cannot be
 * rolled back.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { assertSafeTestDatabase, TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { ComputerTurn, Observation } from '../browser-session.js';
import type { FillTurn } from '../../vault/fill.js';

const LIVE = process.env.BOTS_LIVE === '1';
const SITE = 'http://127.0.0.1:8765';
const TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const SERVER = String.raw`
import json, http.server, urllib.parse
PAGES = {
  '/login': '<title>Sign in</title><h1>Sign in</h1><form method="post" action="/session"><label>Email <input name="login" autocomplete="username"></label><label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
  '/otp': '<title>Two-factor</title><form method="post" action="/verify"><label>Code <input name="code" autocomplete="one-time-code"></label><button>Verify</button></form>',
  '/home': '<title>Home</title><h1>Signed in</h1><p>Welcome</p>',
  '/prefilled': '<title>Account</title><label>Password <input type="password" value="live-secret-123"></label><label>Code <input autocomplete="one-time-code" value="909192"></label>',
}
class H(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    body = PAGES.get(self.path.split('?')[0])
    self.send_response(200 if body else 404); self.send_header('content-type', 'text/html; charset=utf-8'); self.end_headers()
    self.wfile.write(('<!doctype html><meta charset=utf-8>' + (body or 'not found')).encode())
  def do_POST(self):
    data = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get('content-length', 0))).decode())
    with open('/home/agent/work/live-site/posts.jsonl', 'a') as f: f.write(json.dumps({'path': self.path, 'fields': {k: v[0] for k, v in data.items()}}) + '\n')
    self.send_response(303); self.send_header('location', '/otp' if self.path == '/session' else '/home'); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
`;

describe.skipIf(!LIVE)('browser + vault on a live computer', { timeout: 180_000 }, () => {
  let db: DatabaseProvider;
  let user: UserRow;
  let runtime: typeof import('../runtime.js');
  let access: typeof import('../access.js');
  let session: typeof import('../browser-session.js');
  let fill: typeof import('../../vault/fill.js');
  let leases: typeof import('../tab-leases.js');
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    // A user and a computer are created and deleted for real: only ever on a disposable database.
    assertSafeTestDatabase(TEST_DATABASE_URL);
    process.env.TOKEN_SIGNING_KEY ??= randomBytes(32).toString('hex');
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await db.users.create({
      email: `bots-live-a2-${randomUUID()}@test.local`,
      password_hash: 'x',
      nickname: 'LiveA2',
      role: 'team',
    });
    runtime = await import('../runtime.js');
    access = await import('../access.js');
    session = await import('../browser-session.js');
    fill = await import('../../vault/fill.js');
    leases = await import('../tab-leases.js');
    await runtime.initBotComputers();
    expect(runtime.getComputerRuntime().state).toBe('ready');

    const started = Date.now();
    await access.ensureComputerReady(user.id);
    timings.cold_start = Date.now() - started;
    await access.writeComputerFile(user.id, '/home/agent/work/live-site/server.py', Buffer.from(SERVER));
    const boot = await access.execInComputer(
      user.id,
      'cd ~/work/live-site && rm -f posts.jsonl && (setsid -f python3 server.py >/dev/null 2>&1) && for i in $(seq 1 50); do curl -sf http://127.0.0.1:8765/home >/dev/null && echo up && break; sleep 0.1; done',
      { timeoutSec: 30 },
    );
    expect(boot.stdout).toContain('up');
  }, 180_000);

  afterAll(async () => {
    if (runtime && user) {
      await runtime.purgeUserComputer(user.id, { wipe: true }).catch(() => undefined);
      await runtime.shutdownBotComputers();
    }
    if (db && user) await db.users.delete(user.id).catch(() => undefined);
    await db?.close();
    _resetProvider();
    // The live run reports its timings (the app logger is silenced in tests).
    process.stdout.write(`[bots-live-a2] timings (ms) ${JSON.stringify(timings)}\n`);
  }, 120_000);

  function turn(botId: string, overrides: Partial<ComputerTurn> = {}): ComputerTurn {
    return {
      db,
      userId: user.id,
      botId,
      sessionId: 'live-session',
      turnId: `turn-${botId}`,
      background: false,
      signal: new AbortController().signal,
      markTainted: () => undefined,
      noteObservation: () => undefined,
      vaultMatches: null,
      ...overrides,
    };
  }

  async function posts(): Promise<Array<{ path: string; fields: Record<string, string> }>> {
    const raw = await access.readComputerFile(user.id, '/home/agent/work/live-site/posts.jsonl', { maxBytes: 65_536 });
    return raw
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path: string; fields: Record<string, string> });
  }

  it('opens leases in their own windows of the persistent profile', async () => {
    const a = new session.BrowserSession(turn('bot_live_a'));
    const b = new session.BrowserSession(turn('bot_live_b'));
    let started = Date.now();
    const first = (await a.run({ action: 'open', url: `${SITE}/home` })) as Observation;
    timings.first_open = Date.now() - started;
    expect(first).toMatchObject({ url: `${SITE}/home`, title: 'Home' });
    started = Date.now();
    expect(await b.run({ action: 'open', url: `${SITE}/login` })).toMatchObject({ title: 'Sign in' });
    timings.second_open = Date.now() - started;

    const browser = await access.getBrowser(user.id);
    const registry = leases.leaseRegistryFor(browser);
    const pageA = registry.get({ kind: 'foreground', botId: 'bot_live_a', sessionId: 'live-session' })!.currentPage()!;
    const pageB = registry.get({ kind: 'foreground', botId: 'bot_live_b', sessionId: 'live-session' })!.currentPage()!;
    const cdp = await browser.newBrowserCDPSession();
    const win = async (page: typeof pageA) =>
      (
        (await cdp.send('Browser.getWindowForTarget', {
          targetId: (await leases.targetIdOf(page.context(), page))!,
        })) as { windowId: number }
      ).windowId;
    expect(await win(pageA)).not.toBe(await win(pageB));
    await cdp.detach();
    expect(pageA.context()).toBe(browser.contexts()[0]);
    expect(await pageA.evaluate(() => window.name)).toBe('gh-bot:bot_live_a:live-session');

    // The window that is not in front still renders and screenshots.
    started = Date.now();
    // The live suite has no conversation row, so the chat-file insert is
    // swapped for a sink; storage itself is covered by screenshot-store.test.ts.
    const shooter = new session.BrowserSession(turn('bot_live_a'), {
      ...session.defaultComputerDeps,
      storeScreenshot: async (png) => ({
        file_id: 'cf_live',
        name: 'shot.png',
        size: png.length,
        download_url: '/api/chat-files/cf_live/content',
      }),
    });
    const shot = (await shooter.run({ action: 'screenshot' })) as Observation;
    timings.background_screenshot = Date.now() - started;
    expect(shot).toMatchObject({ type: 'file', download_url: '/api/chat-files/cf_live/content' });
    expect(timings.background_screenshot).toBeLessThan(5_000);
  });

  it('masks filled secrets in snapshots of the real browser', async () => {
    const result = (await new session.BrowserSession(turn('bot_live_mask')).run({
      action: 'open',
      url: `${SITE}/prefilled`,
    })) as Observation;
    expect(result.snapshot).not.toContain('live-secret-123');
    expect(result.snapshot).not.toContain('909192');
    expect(result.snapshot).toContain('••• (15 chars)');
  });

  it('fills a login and a TOTP code from the vault, end to end', async () => {
    const { createVaultItem } = await import('../../vault/service.js');
    const item = await createVaultItem(db, user.id, {
      label: 'Live site',
      origins: [SITE],
      username: 'live@example.com',
      password: 'Live-Pass-42!',
      totp: TOTP,
      policy: 'auto',
    });
    const botId = 'bot_live_vault';
    const browser = new session.BrowserSession(turn(botId));
    const opened = (await browser.run({ action: 'open', url: `${SITE}/login` })) as Observation;
    expect(opened.snapshot).toContain('textbox "Password"');

    const fillTurn: FillTurn = {
      db,
      userId: user.id,
      botId,
      botName: 'Live',
      sessionId: 'live-session',
      locale: 'en',
      background: false,
      userTriggered: true,
      observedForeign: () => null,
      signal: new AbortController().signal,
      requestApproval: vi.fn(async () => 'approve' as const),
    };
    let started = Date.now();
    const login = await fill.fillLogin(fillTurn, { item_id: item.id, submit: true });
    timings.fill_login = Date.now() - started;
    expect(login).toMatchObject({ filled: true, origin: SITE, fields: ['username', 'password'], submitted: true });

    const otpPage = (await browser.run({ action: 'snapshot' })) as Observation;
    expect(otpPage.title).toBe('Two-factor');
    expect(JSON.stringify(otpPage)).not.toContain('Live-Pass-42!');

    started = Date.now();
    const otp = await fill.fillTotp(fillTurn, { item_id: item.id, submit: true });
    timings.fill_totp = Date.now() - started;
    expect(otp).toMatchObject({ filled: true, fields: ['otp'] });

    const received = await posts();
    expect(received[0]).toEqual({ path: '/session', fields: { login: 'live@example.com', password: 'Live-Pass-42!' } });
    expect(received[1]!.path).toBe('/verify');
    expect(received[1]!.fields.code).toMatch(/^\d{6}$/);
    const home = (await browser.run({ action: 'snapshot' })) as Observation;
    expect(home.title).toBe('Home');
    expect((await db.vault.listAccess(user.id)).map((row) => row.outcome)).toEqual(['filled', 'filled']);
  });

  it('refuses to observe while the member holds the computer', async () => {
    await db.botComputers.setLease(user.id, 'user');
    try {
      expect(await new session.BrowserSession(turn('bot_live_a')).run({ action: 'snapshot' })).toMatchObject({
        code: 'user_in_control',
      });
    } finally {
      await db.botComputers.setLease(user.id, 'bot');
    }
  });
});
