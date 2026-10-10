/**
 * gh-bridge (apps/bot-computer/e2b/gh-bridge.mjs) against the API's client
 * (e2b-bridge.ts), both for real: the script runs under this machine's Node on
 * a free loopback port, with its own secret file and a socket directory of
 * echo servers standing in for the browser's VNC / DevTools sockets.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bridgeExec, bridgeStream, bridgeTunnel, type BridgeTarget } from '../e2b-bridge.js';

const BRIDGE_SCRIPT = fileURLToPath(new URL('../../../../../bot-computer/e2b/gh-bridge.mjs', import.meta.url));
const WS_PACKAGE = fileURLToPath(new URL('../../../../node_modules/ws', import.meta.url));

let dir = '';
let bridge: ChildProcess | null = null;
let echoPort = 0;
let target: BridgeTarget;
const echoServers: NetServer[] = [];
const secret = randomBytes(24).toString('hex');

async function freePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gh-bridge-'));
  // The script resolves `ws` next to itself, as /opt/gh-bridge does in the template.
  const app = join(dir, 'app');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  copyFileSync(BRIDGE_SCRIPT, join(app, 'gh-bridge.mjs'));
  symlinkSync(WS_PACKAGE, join(app, 'node_modules', 'ws'));
  writeFileSync(join(dir, 'secret'), secret, { mode: 0o400 });
  const sockets = join(dir, 'browser');
  mkdirSync(sockets, { mode: 0o700 });
  for (const name of ['vnc.sock', 'cdp.sock']) {
    const server = createNetServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server.listen(join(sockets, name), resolve));
    echoServers.push(server);
  }
  // A service on the "computer" for port previews (/port?n=): an echo over TCP.
  const echo = createNetServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoPort = (echo.address() as { port: number }).port;
  echoServers.push(echo);
  const port = await freePort();
  bridge = spawn(process.execPath, [join(app, 'gh-bridge.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GH_BRIDGE_PORT: String(port),
      GH_BRIDGE_SECRET_FILE: join(dir, 'secret'),
      GH_BRIDGE_TUNNELS: '1',
      GH_BRIDGE_PORTS: '1',
      GH_BRIDGE_SOCKET_DIR: sockets,
      GH_BRIDGE_READY_FILE: join(dir, 'ready'),
      GH_TEST_INHERITED: 'from-the-unit',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitFor(() => existsSync(join(dir, 'ready')));
  target = { origin: `ws://127.0.0.1:${port}`, headers: { 'x-gh-bridge-secret': secret } };
});

afterAll(async () => {
  bridge?.kill('SIGKILL');
  for (const server of echoServers) server.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('gh-bridge', () => {
  it('refuses an upgrade without the secret, with a wrong one, or to an unknown path', async () => {
    for (const headers of [{}, { 'x-gh-bridge-secret': 'x'.repeat(48) }] as Array<Record<string, string>>) {
      await expect(bridgeExec({ ...target, headers }, { argv: ['true'], timeoutMs: 5_000 })).rejects.toMatchObject({
        name: 'BridgeConnectionError',
        status: 403,
      });
    }
    const unknown = bridgeTunnel(target, '/nope' as '/vnc');
    const error = await new Promise<Error>((resolve) => unknown.on('error', resolve));
    expect(error).toMatchObject({ status: 403 });
  });

  it('runs a command: stdout, stderr and the exit code apart, the env of the unit plus the call', async () => {
    const result = await bridgeExec(target, {
      argv: ['sh', '-c', 'echo "out $GH_TEST_INHERITED $EXTRA"; echo err >&2; exit 3'],
      env: { EXTRA: 'from-the-call' },
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(3);
    expect(result.stdout.toString()).toBe('out from-the-unit from-the-call\n');
    expect(result.stderr).toBe('err\n');
    expect(result).toMatchObject({ timedOut: false, aborted: false, stdoutTruncated: false });
    // The bridge's own knobs never reach a command.
    const env = await bridgeExec(target, { argv: ['env'], timeoutMs: 10_000 });
    expect(env.stdout.toString()).not.toMatch(/GH_BRIDGE_/);
  });

  it('is binary-safe both ways and streams stdin from bytes or a stream', async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const fromBuffer = await bridgeExec(target, {
      argv: ['cat'],
      input: bytes,
      timeoutMs: 20_000,
      maxStdoutBytes: 8 << 20,
    });
    expect(fromBuffer.code).toBe(0);
    expect(fromBuffer.stdout.equals(bytes)).toBe(true);
    const fromStream = await bridgeExec(target, {
      argv: ['sh', '-c', 'wc -c'],
      input: Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]),
      timeoutMs: 20_000,
    });
    expect(fromStream.stdout.toString().trim()).toBe(String(bytes.length));
  });

  it('caps stdout like docker exec: the rest is drained, the exit still arrives', async () => {
    const result = await bridgeExec(target, {
      argv: ['sh', '-c', 'head -c 300000 /dev/zero; exit 0'],
      maxStdoutBytes: 1000,
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1000);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('kills at the deadline and on abort; reports 126 / 127 like a failed docker exec', async () => {
    const slow = await bridgeExec(target, { argv: ['sleep', '30'], timeoutMs: 300 });
    expect(slow).toMatchObject({ timedOut: true });
    const controller = new AbortController();
    const pending = bridgeExec(target, { argv: ['sleep', '30'], timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ aborted: true });
    const missing = await bridgeExec(target, { argv: ['/no/such/binary'], timeoutMs: 5_000 });
    expect(missing.code).toBe(127);
    const noCwd = await bridgeExec(target, { argv: ['true'], cwd: '/no/such/dir', timeoutMs: 5_000 });
    expect(noCwd.code).toBe(126);
    expect(noCwd.stderr).toMatch(/no such directory/);
  });

  it('reports a signalled process as 128 + n', async () => {
    const result = await bridgeExec(target, { argv: ['sh', '-c', 'kill -9 $$'], timeoutMs: 5_000 });
    expect(result.code).toBe(137);
    expect(result.signal).toBe('SIGKILL');
  });

  it('streams a long-lived process like a child (stdin, stdout, exit)', async () => {
    const child = bridgeStream(target, ['sh', '-c', 'while read line; do echo "got $line"; done; echo bye']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stdin.write('one\n');
    child.stdin.write('two\n');
    child.stdin.end();
    const [code] = await new Promise<[number | null]>((resolve) => child.once('close', (c) => resolve([c])));
    expect(code).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('got one\ngot two\nbye\n');
  });

  it('connects a port preview to a local port, never to the bridges or the provider agent', async () => {
    const tunnel = bridgeTunnel(target, `/port?n=${echoPort}`);
    const received: Buffer[] = [];
    tunnel.stdout.on('data', (chunk: Buffer) => received.push(chunk));
    tunnel.stdin.write(Buffer.from('GET / HTTP/1.1\r\n'));
    await waitFor(() => Buffer.concat(received).toString() === 'GET / HTTP/1.1\r\n');
    tunnel.kill();
    await new Promise((resolve) => tunnel.once('exit', resolve));
    for (const port of [7681, 7682, 49983, 22, 0]) {
      const refused = bridgeTunnel(target, `/port?n=${port}`);
      const error = await new Promise<Error>((resolve) => refused.on('error', resolve));
      expect(error).toMatchObject({ status: 403 });
    }
  });

  it('tunnels raw bytes to the browser sockets', async () => {
    for (const path of ['/vnc', '/cdp'] as const) {
      const tunnel = bridgeTunnel(target, path);
      const received: Buffer[] = [];
      tunnel.stdout.on('data', (chunk: Buffer) => received.push(chunk));
      const payload = Buffer.from([0, 1, 2, 255, 0x52, 0x46, 0x42]);
      tunnel.stdin.write(payload);
      await waitFor(() => Buffer.concat(received).length >= payload.length);
      expect(Buffer.concat(received).equals(payload)).toBe(true);
      tunnel.kill();
      await new Promise((resolve) => tunnel.once('exit', resolve));
    }
  });
});

describe('gh-bridge under systemd socket activation', () => {
  const appScript = () => join(dir, 'app', 'gh-bridge.mjs');

  it('refuses to bind a port of its own when the unit requires the systemd socket', async () => {
    const child = spawn(process.execPath, [appScript()], {
      env: {
        PATH: process.env.PATH,
        GH_BRIDGE_PORT: '1',
        GH_BRIDGE_REQUIRE_SOCKET: '1',
        GH_BRIDGE_SECRET_FILE: join(dir, 'secret'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(2);
    expect(stderr).toMatch(/no listening socket from systemd/);
  });

  it('serves the socket systemd passes as fd 3, and keeps systemd’s variables from what it runs', async () => {
    // What a socket unit does: PID 1 binds and listens, the service inherits the socket as fd 3.
    const listener = createNetServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    const fd = (listener as unknown as { _handle: { fd: number } })._handle.fd;
    const ready = join(dir, 'ready-socket');
    const child = spawn('sh', ['-c', `LISTEN_PID=$$ exec "${process.execPath}" "${appScript()}"`], {
      env: {
        PATH: process.env.PATH,
        LISTEN_FDS: '1',
        GH_BRIDGE_REQUIRE_SOCKET: '1',
        GH_BRIDGE_SECRET_FILE: join(dir, 'secret'),
        GH_BRIDGE_READY_FILE: ready,
      },
      stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    // The parent lets go of its copy: only the bridge serves the socket now.
    listener.close();
    try {
      await waitFor(() => existsSync(ready));
      const socketTarget = { origin: `ws://127.0.0.1:${port}`, headers: { 'x-gh-bridge-secret': secret } };
      const env = await bridgeExec(socketTarget, { argv: ['env'], timeoutMs: 10_000 });
      expect(env.code).toBe(0);
      expect(env.stdout.toString()).not.toMatch(/^LISTEN_/m);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
