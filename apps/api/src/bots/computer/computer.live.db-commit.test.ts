/**
 * Live verification of the computer runtime against a real Docker daemon and
 * PostgreSQL — skipped unless BOTS_LIVE=1. It drives the production code path
 * end to end: prechecks → create a member's computer → Playwright over the
 * DevTools bridge → a real page → the Bot shell (output, timeout, abort, files)
 * → the live viewer over a real WebSocket → stop/rm → start again with the
 * profile and files intact → wipe.
 *
 *   BOTS_LIVE=1 NODE_ENV=development BOTS_COMPUTER_ENABLED=1 \
 *   BOTS_COMPUTER_ALLOW_UNHARDENED=1 BOTS_COMPUTER_RUNTIME=runc \
 *   TEST_DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test \
 *   npx vitest run --project db-commit apps/api/src/bots/computer/computer.live.db-commit.test.ts
 *
 * Needs the image (bash scripts/build-bot-computer.sh) and internet access
 * from containers (it opens https://cn.bing.com).
 *
 * @db-commit-reason one real Docker lifecycle spans several tests, and the
 * computer runtime's controller and timers read committed `bot_computers`
 * rows outside any test transaction; container and volume side effects cannot
 * be rolled back.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import * as wsModule from 'ws';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { assertSafeTestDatabase, TEST_DATABASE_URL } from '@greenhouse/db/test-config';

const LIVE = process.env.BOTS_LIVE === '1';

type Access = typeof import('./access.js');
type Runtime = typeof import('./runtime.js');

describe.skipIf(!LIVE)('bot computer (live Docker)', () => {
  let db: DatabaseProvider;
  let user: UserRow;
  let access: Access;
  let runtime: Runtime;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    // Users and computers are created and deleted for real: only ever on a disposable database.
    assertSafeTestDatabase(TEST_DATABASE_URL);
    process.env.TOKEN_SIGNING_KEY ??= randomBytes(32).toString('hex');
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await db.users.create({
      email: `bots-live-${randomUUID()}@test.local`,
      password_hash: 'x',
      nickname: 'Live',
      role: 'team',
    });
    runtime = await import('./runtime.js');
    access = await import('./access.js');
    await runtime.initBotComputers();
  }, 120_000);

  afterAll(async () => {
    if (runtime && user) {
      await runtime.purgeUserComputer(user.id, { wipe: true }).catch(() => {});
      await runtime.shutdownBotComputers();
    }
    if (db && user) await db.users.delete(user.id).catch(() => {});
    await db?.close();
    _resetProvider();
    // The live run reports its timings.
    console.log('[bots-live] timings (ms)', timings);
  }, 120_000);

  it('passes the prechecks', () => {
    const view = runtime.getComputerRuntime();
    expect(view).toEqual({ state: 'ready', reason: null, hardened: false });
    expect(runtime.botsComputerHealthView().state).toBe('ready');
  });

  it('starts a computer and drives its browser', async () => {
    const started = Date.now();
    await access.ensureComputerReady(user.id);
    timings.cold_start = Date.now() - started;
    const row = await db.botComputers.get(user.id);
    expect(row?.state).toBe('running');

    const browser = await access.getBrowser(user.id);
    expect(browser.isConnected()).toBe(true);
    expect(await access.getBrowser(user.id)).toBe(browser); // cached per member

    const context = browser.contexts()[0]!;
    const page = await context.newPage();
    const navStarted = Date.now();
    await page.goto('https://cn.bing.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    timings.bing_load = Date.now() - navStarted;
    expect(page.url()).toContain('bing.com');
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 15_000 });
    expect(snapshot.length).toBeGreaterThan(20);
    // A cookie for the persistence check after a restart.
    await context.addCookies([
      { name: 'gh_live_probe', value: 'kept', domain: '.bing.com', path: '/', expires: Date.now() / 1000 + 86_400 },
    ]);
    // file:// (the profile) and greenhouse itself are blocked by policy.
    const blocked = await page.goto('file:///home/browser/chromium/Default/Preferences').catch((err: Error) => err);
    expect(String(blocked)).toMatch(/ERR_BLOCKED_BY_ADMINISTRATOR/);
    await page.close();
  }, 180_000);

  it('runs Bot commands as agent with output, timeout and abort', async () => {
    const result = await access.execInComputer(
      user.id,
      'id -un; mkdir -p ~/work && echo hello > ~/work/hello.txt && cat ~/work/hello.txt; echo "proxy=[$HTTPS_PROXY]"',
      { timeoutSec: 20 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('agent');
    expect(result.stdout).toContain('hello');
    expect(result.stdout).toContain('proxy=[]');
    expect(result.stdout).not.toContain('__GH_SID__');

    const denied = await access.execInComputer(user.id, 'ls /home/browser; cat /tmp/browser/cdp.sock', {
      timeoutSec: 10,
    });
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toMatch(/Permission denied/);

    const timeoutStarted = Date.now();
    const slow = await access.execInComputer(user.id, '(sleep 300 &) ; sleep 300', { timeoutSec: 3 });
    timings.timeout_return = Date.now() - timeoutStarted;
    expect(slow.timedOut).toBe(true);
    const leftovers = await access.execInComputer(user.id, 'pgrep -u agent -a sleep || echo none', { timeoutSec: 10 });
    expect(leftovers.stdout.trim()).toBe('none');

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_000);
    const abortStarted = Date.now();
    await access.execInComputer(user.id, 'sleep 120', { timeoutSec: 60, signal: controller.signal }).catch(() => null);
    expect(Date.now() - abortStarted).toBeLessThan(15_000);
    const afterAbort = await access.execInComputer(user.id, 'pgrep -u agent -a sleep || echo none', { timeoutSec: 10 });
    expect(afterAbort.stdout.trim()).toBe('none');

    const capped = await access.execInComputer(user.id, 'head -c 200000 /dev/zero | tr "\\0" a', {
      timeoutSec: 10,
      maxOutputBytes: 1000,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.stdout.length).toBeLessThanOrEqual(1000);
  }, 120_000);

  it('reads and writes binary files as agent', async () => {
    const payload = randomBytes(300_000);
    await access.writeComputerFile(user.id, 'work/blob.bin', payload);
    const back = await access.readComputerFile(user.id, '/home/agent/work/blob.bin', { maxBytes: 1_000_000 });
    expect(Buffer.compare(back, payload)).toBe(0);
    await expect(access.readComputerFile(user.id, 'work/blob.bin', { maxBytes: 1000 })).rejects.toThrow(/too large/);
    await expect(
      access.readComputerFile(user.id, '/home/browser/chromium/Default/Preferences', { maxBytes: 1000 }),
    ).rejects.toThrow();
  }, 60_000);

  it('captures the desktop', async () => {
    const png = await access.captureDesktop(user.id);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.length).toBeGreaterThan(5_000);
  }, 60_000);

  it('serves the live viewer over a real WebSocket, view-only until take-over', async () => {
    const { createComputerViewerRoutes } = await import('./viewer.js');
    const { createViewToken } = await import('./view-token.js');
    const WsServerCtor = (wsModule.WebSocketServer ??
      (wsModule as unknown as { default: typeof wsModule }).default.WebSocketServer) as typeof wsModule.WebSocketServer;
    const WsClient = (wsModule.WebSocket ??
      (wsModule as unknown as { default: typeof wsModule }).default.WebSocket) as typeof wsModule.WebSocket;
    const wss = new WsServerCtor({ noServer: true });
    const app = createComputerViewerRoutes();
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1', websocket: { server: wss } });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const row = await db.botComputers.get(user.id);
      const account = await db.users.getById(user.id);
      const { token } = createViewToken({ id: user.id, authVersion: account!.auth_version }, row!.container_name);

      const socket = new WsClient(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
      const received: Buffer[] = [];
      socket.on('message', (data: Buffer) => received.push(Buffer.from(data)));
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const waitBytes = async (n: number) => {
        const deadline = Date.now() + 20_000;
        while (Buffer.concat(received).length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        return Buffer.concat(received);
      };
      const greeting = await waitBytes(12);
      expect(greeting.subarray(0, 12).toString('latin1')).toBe('RFB 003.008\n');
      received.length = 0;
      socket.send(Buffer.from('RFB 003.008\n'));
      const security = await waitBytes(2); // [count, ...types]
      expect([...security.subarray(1, 1 + security[0]!)]).toContain(1);
      received.length = 0;
      socket.send(Buffer.from([1])); // None
      const result = await waitBytes(4);
      expect(result.readUInt32BE(0)).toBe(0); // SecurityResult OK
      received.length = 0;
      socket.send(Buffer.from([0])); // ClientInit exclusive → rewritten to shared by the filter
      const init = await waitBytes(24);
      expect(init.readUInt16BE(0)).toBe(1280);
      expect(init.readUInt16BE(2)).toBe(800);
      expect((await db.botComputers.get(user.id))?.viewer_heartbeat_at).not.toBeNull();

      // View-only is enforced by the server: VNC keystrokes reach the desktop
      // only while the member holds the lease.
      const lease = await import('./lease.js');
      const browser = await access.getBrowser(user.id);
      const page = await browser.contexts()[0]!.newPage();
      await page.setContent('<input id="q" autofocus>');
      await page.bringToFront();
      await page.focus('#q');
      const key = (keysym: number) =>
        [1, 0].map((down) => {
          const message = Buffer.alloc(8);
          message[0] = 4;
          message[1] = down;
          message.writeUInt32BE(keysym, 4);
          return message;
        });
      for (const message of key(0x61)) socket.send(message); // "a" while the Bots hold the lease
      await new Promise((r) => setTimeout(r, 800));
      expect(await page.inputValue('#q')).toBe('');
      await lease.takeoverComputer(user.id);
      for (const message of key(0x62)) socket.send(message); // "b" after taking over
      await expect.poll(() => page.inputValue('#q'), { timeout: 5_000 }).toBe('b');
      await lease.handbackComputer(user.id, {});
      for (const message of key(0x63)) socket.send(message); // "c" after handing back: dropped again
      await new Promise((r) => setTimeout(r, 800));
      expect(await page.inputValue('#q')).toBe('b');
      await page.close();

      // A second ticket use is refused.
      const reused = new WsClient(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
      const code = await new Promise<number>((resolve) => reused.once('close', (c: number) => resolve(c)));
      expect(code).toBe(4001);

      const closed = new Promise<number>((resolve) => socket.once('close', (c: number) => resolve(c)));
      socket.close();
      await closed;
    } finally {
      await new Promise((resolve) => server.close(resolve));
      wss.close();
    }
  }, 90_000);

  it('keeps files and browser logins across stop/rm and a fresh start', async () => {
    const before = await db.botComputers.get(user.id);
    await runtime.stopUserComputer(user.id, 'user');
    const stopped = await db.botComputers.get(user.id);
    expect(stopped?.state).toBe('absent');
    expect(stopped?.state_reason).toBe('user');

    const started = Date.now();
    const browser = await access.getBrowser(user.id);
    timings.warm_start = Date.now() - started;
    const after = await db.botComputers.get(user.id);
    expect(after?.state).toBe('running');
    expect(after?.version).toBeGreaterThan(before!.version);

    const cookies = await browser.contexts()[0]!.cookies('https://cn.bing.com');
    expect(cookies.find((c) => c.name === 'gh_live_probe')?.value).toBe('kept');
    const file = await access.execInComputer(user.id, 'cat ~/work/hello.txt', { timeoutSec: 10 });
    expect(file.stdout.trim()).toBe('hello');
  }, 180_000);

  it('types Chinese into the focused field only while the member holds the lease', async () => {
    const lease = await import('./lease.js');
    const browser = await access.getBrowser(user.id);
    const page = await browser.contexts()[0]!.newPage();
    await page.setContent('<input id="q" autofocus placeholder="search">');
    await page.bringToFront();
    await page.focus('#q');
    await expect(lease.typeIntoFocusedField(user.id, '你好 greenhouse')).rejects.toBeInstanceOf(
      lease.LeaseRequiredError,
    );
    await lease.takeoverComputer(user.id);
    await lease.typeIntoFocusedField(user.id, '你好 greenhouse');
    expect(await page.inputValue('#q')).toBe('你好 greenhouse');
    // The typed value joins the redaction set for Bot observations.
    expect(access.redactFilledSecrets(user.id, 'value=你好 greenhouse')).toBe('value=••••••');
    await lease.handbackComputer(user.id, {});
    await page.close();
  }, 60_000);

  it('takes over and hands back (epoch bumps, Bot shell killed)', async () => {
    const lease = await import('./lease.js');
    const before = await access.currentLease(user.id);
    const bg = access.execInComputer(user.id, 'sleep 60', { timeoutSec: 90 }).catch((err: Error) => err);
    await new Promise((r) => setTimeout(r, 1_000));
    await lease.takeoverComputer(user.id);
    const during = await access.currentLease(user.id);
    expect(during).toEqual({ controller: 'user', epoch: before.epoch + 1 });
    const outcome = await bg;
    expect(outcome).toBeDefined(); // aborted (returns or throws) instead of running 60 s
    await lease.handbackComputer(user.id, {});
    expect(await access.currentLease(user.id)).toEqual({ controller: 'bot', epoch: before.epoch + 2 });
  }, 60_000);
});
