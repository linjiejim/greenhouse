/**
 * Live verification of the e2b host against a real E2B-protocol provider —
 * skipped unless BOTS_E2B_LIVE=1. No database: it drives e2b-host.ts the way
 * the controller does, on the real template (built first when missing, a few
 * minutes) and real sandboxes in namespace `livetest` (all removed afterwards).
 *
 *   BOTS_E2B_LIVE=1 BOTS_COMPUTER_E2B_API_KEY=… [BOTS_COMPUTER_E2B_DOMAIN=cn-beijing-1.sandbox.ppio.com] \
 *   npx vitest run --project unit apps/api/src/bots/computer/__tests__/e2b-host.live.test.ts
 *
 * Covers: create + boot, the member's settings, the uid wall (secret, homes,
 * sudo/su, setuid, sshd, the other uid's bridge and its units, the provider's
 * agent and tokens, a bridge port nobody else can take — not even while the
 * bridge restarts), the shell wrapper, binary
 * output, stdin uploads and streamed downloads, the terminal, the VNC and
 * DevTools tunnels with Playwright, pause → resume (processes survive), a
 * reset moving the home (files and a browser login) into a new sandbox, a
 * runaway job killed inside the Bots' memory slice (nothing else restarts), the
 * recovery of an old sandbox whose home failed to move (RECOVER_SCRIPT), and a
 * port preview through the agent bridge (never to a bridge's own port).
 */

import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { Sandbox } from 'e2b';
import type { BotComputerRow } from '@greenhouse/db';

import type { BotsComputerConfig } from '../config.js';
import { openCdpBridge } from '../cdp-bridge.js';
import { createE2bApi, createE2bHost, RECOVER_SCRIPT } from '../e2b-host.js';
import { buildComputerTemplate, computerTemplateName, templateStatus } from '../e2b-template.js';
import type { ComputerHost, ComputerStartSpec } from '../host.js';
import { IMAGE_CONTRACT } from '../runtime.js';
import { runShell } from '../shell.js';

const LIVE = process.env.BOTS_E2B_LIVE === '1' && !!process.env.BOTS_COMPUTER_E2B_API_KEY;
const NAMESPACE = 'livetest';
const READY_PROBE = [
  'import socket, sys',
  's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  's.settimeout(4)',
  "s.connect('/tmp/browser/cdp.sock')",
  's.sendall(b\'{"id":1,"method":"Browser.getVersion"}\\0\')',
  "buf = b''",
  "while b'\\0' not in buf:",
  '    chunk = s.recv(65536)',
  '    if not chunk:',
  '        break',
  '    buf += chunk',
  "sys.stdout.write(buf.split(b'\\0', 1)[0].decode('utf-8', 'replace'))",
].join('\n');

describe.skipIf(!LIVE)('e2b host (live provider)', () => {
  const conn = {
    apiKey: process.env.BOTS_COMPUTER_E2B_API_KEY ?? '',
    ...(process.env.BOTS_COMPUTER_E2B_DOMAIN ? { domain: process.env.BOTS_COMPUTER_E2B_DOMAIN } : {}),
  };
  const api = createE2bApi(conn);
  const host: ComputerHost = createE2bHost({ api, namespace: NAMESPACE, secretKey: randomBytes(32).toString('hex') });
  const options = { contract: IMAGE_CONTRACT, cpuCount: 2, memoryMB: 2048 };
  const userId = `live-${randomBytes(4).toString('hex')}`;
  let template = '';
  let ref = '';

  const spec = (fresh = false): ComputerStartSpec => ({
    config: { proxy: null } as BotsComputerConfig,
    image: template,
    urlBlocklist: ['blocked.example.com'],
    timezone: 'Asia/Shanghai',
    lang: 'zh-CN',
    fresh,
  });
  const row = (container: string, state_reason: string | null = null) =>
    ({ user_id: userId, container_name: container, volume_name: 'unused', state_reason }) as BotComputerRow;
  /** The provider's envd and traffic tokens for this sandbox (to prove the agent cannot find them). */
  async function providerTokens(): Promise<Record<string, string>> {
    const sandbox = (await Sandbox.connect(ref, conn)) as unknown as {
      envdAccessToken?: string;
      trafficAccessToken?: string;
    };
    return { GH_T_ENVD: sandbox.envdAccessToken ?? '', GH_T_TRAFFIC: sandbox.trafficAccessToken ?? '' };
  }
  /** A root command through the provider's own agent (what the host does for boot steps). */
  async function root(command: string, envs: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    const sandbox = await Sandbox.connect(ref, conn);
    const result = await sandbox.commands
      .run(command, { user: 'root', envs, timeoutMs: 120_000 })
      .catch((err: { exitCode?: number; stdout?: string; stderr?: string }) => ({
        exitCode: err.exitCode ?? -1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      }));
    return { code: result.exitCode, out: `${result.stdout}${result.stderr}`.trim() };
  }
  const exec = (user: 'agent' | 'browser', argv: string[], extra: Record<string, unknown> = {}) =>
    host.exec({ container: ref, user, argv, timeoutMs: 60_000, cwd: `/home/${user}`, ...extra });
  async function waitReady(): Promise<string> {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const result = await exec('browser', ['python3', '-c', READY_PROBE], { timeoutMs: 8_000 }).catch(() => null);
      const product = result?.code === 0 ? JSON.parse(result.stdout.toString() || '{}')?.result?.product : null;
      if (product) return product as string;
      if (Date.now() > deadline) throw new Error('the browser did not come up');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  beforeAll(async () => {
    template = await computerTemplateName(options);
    if ((await templateStatus(conn, template)).state !== 'ready') await buildComputerTemplate(conn, options, () => {});
  }, 15 * 60_000);

  afterAll(async () => {
    for (const sandbox of await api.list(NAMESPACE).catch(() => [])) await api.kill(sandbox.sandboxId).catch(() => {});
  }, 120_000);

  it('creates and boots a computer with the member’s settings', async () => {
    const started = await host.start(row(`gh-computer-${NAMESPACE}-${userId}`), spec());
    ref = started.ref;
    expect(started.imageId).toBe(template);
    expect(await waitReady()).toMatch(/^Chrome\//);
    const who = await exec('agent', ['sh', '-c', 'id -un; date +%Z; echo "$GH_COMPUTER_LANG"']);
    expect(who.stdout.toString()).toBe('agent\nCST\nzh-CN\n');
    const policy = await exec('browser', ['cat', '/tmp/browser/policy.json']);
    expect(policy.stdout.toString()).toContain('blocked.example.com');
  }, 180_000);

  it('keeps the agent uid off the browser side and away from root', async () => {
    const result = await exec(
      'agent',
      [
        'sh',
        '-c',
        [
          'cat /etc/gh-bridge/browser.secret >/dev/null 2>&1 && echo LEAK_secret',
          'ls /home/browser >/dev/null 2>&1 && echo LEAK_home',
          'ls /tmp/browser >/dev/null 2>&1 && echo LEAK_run',
          'sudo -n true >/dev/null 2>&1 && echo LEAK_sudo',
          'su -c true root </dev/null >/dev/null 2>&1 && echo LEAK_su',
          'touch /usr/local/bin/gh-computer 2>/dev/null && echo LEAK_usrlocal',
          'pgrep -x sshd >/dev/null && echo LEAK_sshd',
          'find / -xdev -perm /6000 -type f 2>/dev/null | head -3 | sed "s/^/LEAK_setuid /"',
          `code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "x-gh-bridge-secret: $(cat /etc/gh-bridge/agent.secret)" http://127.0.0.1:7681/vnc); [ "$code" = 403 ] || echo LEAK_bridge_$code`,
          `code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:49983/process.Process/List); case "$code" in 401|403) ;; *) echo LEAK_envd_$code;; esac`,
          'systemctl stop gh-bridge-browser.service gh-bridge-browser.socket >/dev/null 2>&1 && echo LEAK_systemctl',
          // The provider's own tokens: in no env, argv or readable file of the agent.
          'for t in "$GH_T_ENVD" "$GH_T_TRAFFIC"; do [ -n "$t" ] || continue; ' +
            'ps -eo args= | grep -v grep | grep -qF "$t" && echo LEAK_token_argv; ' +
            'f=$(grep -rlsF "$t" /etc /run /var /tmp /opt /usr/local /home /root 2>/dev/null | head -1); [ -n "$f" ] && echo LEAK_token_file; done',
          'echo checked',
        ].join('; '),
      ],
      { env: await providerTokens() },
    );
    expect(result.stdout.toString().trim().split('\n')).toEqual(['checked']);
  }, 120_000);

  it('holds the bridge ports in PID 1: the agent cannot take one, not even while the bridge restarts', async () => {
    const squat = [
      'import socket, time',
      'won = 0',
      'end = time.time() + 6',
      'while time.time() < end:',
      '    s = socket.socket()',
      '    try:',
      "        s.bind(('127.0.0.1', 7681))",
      '        won += 1',
      '    except OSError:',
      '        pass',
      '    s.close()',
      'print(won)',
    ].join('\n');
    const attempt = exec('agent', ['python3', '-c', squat], { timeoutMs: 30_000 });
    // Meanwhile the browser bridge restarts (as a settings change or a crash would).
    const root = await api.connect(ref);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await root.runRoot('systemctl restart gh-bridge-browser.service', {}, 30_000)).code).toBe(0);
    expect((await attempt).stdout.toString().trim()).toBe('0');
  }, 60_000);

  it('runs the Bot shell, returns binary output intact and moves files both ways', async () => {
    const shell = await runShell(host, ref, 'echo "hi $(whoami)"; echo oops >&2; exit 4', {
      user: 'agent',
      timeoutSec: 30,
      proxy: null,
    });
    expect(shell).toMatchObject({ exitCode: 4, stdout: 'hi agent\n', stderr: 'oops\n' });
    expect((await runShell(host, ref, 'sleep 30', { user: 'agent', timeoutSec: 2, proxy: null })).timedOut).toBe(true);

    const shot = await host.exec({
      container: ref,
      user: 'browser',
      env: { DISPLAY: ':0', XAUTHORITY: '/home/browser/.Xauthority', HOME: '/home/browser' },
      argv: ['import', '-window', 'root', 'png:-'],
      timeoutMs: 30_000,
      maxStdoutBytes: 32 << 20,
    });
    expect(shot.stdout.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const payload = randomBytes(2 * 1024 * 1024 + 3);
    await exec('agent', ['sh', '-c', 'mkdir -p ~/work && cat > ~/work/blob.bin'], {
      input: payload,
      timeoutMs: 120_000,
    });
    const sum = await exec('agent', ['sha256sum', '/home/agent/work/blob.bin']);
    expect(sum.stdout.toString()).toMatch(new RegExp(`^${createHash('sha256').update(payload).digest('hex')}`));
    const download = host.execStream(ref, 'agent', ['cat', '/home/agent/work/blob.bin'], { cwd: '/home/agent' });
    const chunks: Buffer[] = [];
    download.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    await new Promise((resolve) => download.once('close', resolve));
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  }, 180_000);

  it('serves the terminal and both tunnels; Playwright drives the browser and the blocklist holds', async () => {
    const terminal = host.execStream(ref, 'agent', ['gh-term'], { cwd: '/home/agent', env: { HOME: '/home/agent' } });
    const output: Buffer[] = [];
    terminal.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
    // gh-term's stdin frames: type u8, length u32 big-endian, payload (terminal.ts).
    const framed = (type: number, payload: Buffer) => {
      const head = Buffer.alloc(5);
      head.writeUInt8(type, 0);
      head.writeUInt32BE(payload.length, 1);
      return Buffer.concat([head, payload]);
    };
    terminal.stdin!.write(framed(1, Buffer.from(JSON.stringify({ cols: 100, rows: 30 }))));
    terminal.stdin!.write(framed(0, Buffer.from('echo TERM_$((6*7))\r')));
    const deadline = Date.now() + 15_000;
    while (!Buffer.concat(output).toString().includes('TERM_42') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    terminal.stdin!.end();
    expect(Buffer.concat(output).toString()).toContain('TERM_42');

    const vnc = host.openTunnel(ref, 'vnc');
    const banner = await new Promise<string>((resolve) => {
      const parts: Buffer[] = [];
      vnc.stdout!.on('data', (chunk: Buffer) => {
        parts.push(chunk);
        if (Buffer.concat(parts).length >= 12) resolve(Buffer.concat(parts).toString('latin1'));
      });
    });
    vnc.kill();
    expect(banner).toMatch(/^RFB 003\.00\d/);

    const bridge = await openCdpBridge({ spawnTunnel: () => host.openTunnel(ref, 'cdp') });
    const browser = await chromium.connectOverCDP(bridge.url, { noDefaults: true, timeout: 30_000 });
    const page = await browser.contexts()[0]!.newPage();
    await page.goto('https://example.com', { timeout: 30_000 });
    expect(await page.title()).toBe('Example Domain');
    const blocked = await page.goto('http://blocked.example.com/', { timeout: 15_000 }).then(
      () => 'loaded',
      (err: Error) => err.message,
    );
    expect(blocked).toMatch(/ERR_BLOCKED_BY_ADMINISTRATOR/);
    await browser
      .contexts()[0]!
      .addCookies([
        { name: 'gh_live', value: 'kept', domain: 'example.com', path: '/', expires: Date.now() / 1000 + 86_400 },
      ]);
    await page.close();
    await browser.close().catch(() => {});
    await bridge.close();
  }, 120_000);

  it('pauses and resumes with every process still there', async () => {
    await exec('agent', ['sh', '-c', 'nohup sleep 3000 >/dev/null 2>&1 & echo $! > ~/work/sleeper.pid']);
    const pid = (await exec('agent', ['cat', '/home/agent/work/sleeper.pid'])).stdout.toString().trim();
    await host.stop(ref);
    expect(await host.inspect(ref)).toEqual({ running: false });
    const resumed = await host.start(row(ref), spec());
    expect(resumed.ref).toBe(ref);
    // Still paused (never killed) on timeout after a resume: the dead-man switch keeps the home.
    expect((await api.getInfo(ref))?.lifecycle?.onTimeout).toBe('pause');
    await waitReady();
    expect((await exec('agent', ['sh', '-c', `kill -0 ${pid} && echo alive`])).stdout.toString()).toContain('alive');
  }, 180_000);

  it('a reset moves the home — files and the browser’s login — into a new sandbox, keeping the old one paused', async () => {
    const marker = randomBytes(8).toString('hex');
    await exec('agent', ['sh', '-c', `echo ${marker} > ~/work/marker.txt`]);
    const old = ref;
    await host.stop(old);
    const moved = await host.start(row(old, 'reset'), spec(true));
    ref = moved.ref;
    expect(ref).not.toBe(old);
    await waitReady();
    expect((await exec('agent', ['cat', '/home/agent/work/marker.txt'])).stdout.toString().trim()).toBe(marker);
    const bridge = await openCdpBridge({ spawnTunnel: () => host.openTunnel(ref, 'cdp') });
    const browser = await chromium.connectOverCDP(bridge.url, { noDefaults: true, timeout: 30_000 });
    const cookies = await browser.contexts()[0]!.cookies('https://example.com');
    await browser.close().catch(() => {});
    await bridge.close();
    expect(cookies.find((cookie) => cookie.name === 'gh_live')?.value).toBe('kept');
    expect(await host.inspect(old)).toEqual({ running: false });
    const all = await host.list(NAMESPACE);
    expect(await host.removeOrphan(all.find((instance) => instance.ref === old)!, all)).toBe(false);
  }, 300_000);

  it('kills a runaway job inside the Bots’ memory slice: the desktop, the bridges and other work carry on', async () => {
    const show = async (unit: string, prop: string) => (await root(`systemctl show ${unit} -p ${prop} --value`)).out;
    expect(await show('gh-agent.slice', 'MemoryMax')).toMatch(/^\d+$/);
    expect(await show('gh-bridge-agent.service', 'Slice')).toBe('gh-agent.slice');
    const restartsBefore = await show('gh-bridge-agent.service', 'NRestarts');
    const browserBefore = (await root('pgrep -o -u browser -x chromium')).out;
    await exec('agent', ['sh', '-c', 'nohup sleep 3000 >/dev/null 2>&1 & echo $! > ~/work/bystander.pid']);
    const bystander = (await exec('agent', ['cat', '/home/agent/work/bystander.pid'])).stdout.toString().trim();

    // Twice the slice's ceiling, written so the pages are really used.
    const hog = await exec(
      'agent',
      ['python3', '-c', 'b = []\nfor _ in range(40):\n    b.append(b"x" * (50 << 20))\nprint("survived")'],
      { timeoutMs: 120_000 },
    );
    expect(hog.stdout.toString()).not.toContain('survived');
    expect(hog.code).not.toBe(0); // killed by the kernel (137), never a clean exit

    // The kill stayed inside the slice: nothing restarted, nobody else was chosen.
    expect(await show('gh-bridge-agent.service', 'NRestarts')).toBe(restartsBefore);
    expect((await root('systemctl is-active gh-desktop.service gh-bridge-browser.service')).out).toBe('active\nactive');
    expect((await root('pgrep -o -u browser -x chromium')).out).toBe(browserBefore);
    expect((await exec('agent', ['sh', '-c', `kill -0 ${bystander} && echo alive`])).stdout.toString()).toContain(
      'alive',
    );
    await waitReady();
  }, 240_000);

  it('recovers an old computer whose home failed to move: no agent process left, then its desktop again', async () => {
    await exec('agent', ['sh', '-c', 'nohup sleep 3000 >/dev/null 2>&1 & echo $! > ~/work/leftover.pid']);
    const leftover = (await exec('agent', ['cat', '/home/agent/work/leftover.pid'])).stdout.toString().trim();
    // What a move does to the old sandbox before copying.
    expect((await root('systemctl stop gh-desktop.service')).code).toBe(0);
    // The exact script the host runs on an old sandbox after a failed move.
    const recovered = await root(RECOVER_SCRIPT);
    expect(recovered).toMatchObject({ code: 0 });
    // The Bot's process from before is gone; the desktop and both bridges are back.
    expect((await root(`kill -0 ${leftover} 2>/dev/null && echo alive || echo gone`)).out).toBe('gone');
    expect((await root('systemctl is-active gh-desktop.service')).out).toBe('active');
    expect(await waitReady()).toMatch(/^Chrome\//);
    expect((await exec('agent', ['id', '-un'])).stdout.toString()).toBe('agent\n');
    // And the ordinary wake-up path accepts it again.
    await host.stop(ref);
    expect((await host.start(row(ref), spec())).ref).toBe(ref);
  }, 240_000);

  it('opens a port preview to a service the agent runs, and never to a bridge', async () => {
    await exec('agent', [
      'sh',
      '-c',
      'mkdir -p ~/work/site && echo "<h1>hi from the computer</h1>" > ~/work/site/index.html && cd ~/work/site && (nohup python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &)',
    ]);
    const get = (port: number) =>
      new Promise<string>((resolve, reject) => {
        const proc = host.openPort(ref, port);
        const parts: Buffer[] = [];
        proc.stdout!.on('data', (chunk: Buffer) => parts.push(chunk));
        proc.once('error', reject);
        proc.once('close', () => resolve(Buffer.concat(parts).toString('utf8')));
        proc.stdin!.end('GET /index.html HTTP/1.0\r\nHost: localhost\r\n\r\n');
      });
    let page = '';
    for (let i = 0; i < 20 && !page.includes('hi from the computer'); i++) {
      page = await get(8765).catch(() => '');
      if (!page.includes('hi from the computer')) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(page).toMatch(/^HTTP\/1\.0 200/);
    expect(page).toContain('<h1>hi from the computer</h1>');
    await expect(get(7681)).rejects.toMatchObject({ status: 403 });
  }, 120_000);
});
