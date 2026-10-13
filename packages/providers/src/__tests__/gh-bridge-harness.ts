/**
 * The computer's two bridges for real (apps/bot-computer/e2b/gh-bridge.mjs) under this machine's
 * Node on loopback ports, the way the template runs them: the browser one with the VNC and
 * DevTools tunnels (echo servers stand in for the display's sockets), the agent one with /exec.
 * A `curl` that refuses every connection stands in for the computer's network rules; writing a
 * URL to `leakFile` makes that one answer.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { Connector } from '../sandbox/e2b/bridge.js';

const BRIDGE_SCRIPT = fileURLToPath(new URL('../../../../apps/bot-computer/e2b/gh-bridge.mjs', import.meta.url));
const WS_PACKAGE = fileURLToPath(new URL('../../node_modules/ws', import.meta.url));

export interface Bridge {
  port: number;
  secretFile: string;
}

export interface BridgeHarness {
  dir: string;
  agent: Bridge;
  browser: Bridge;
  leakFile: string;
  /** Writes the secret a bridge expects. */
  setSecret(bridge: Bridge, secret: string): void;
  /** A connector that sends `wss://7681-…` to the browser bridge and `wss://7682-…` to the agent one. */
  connector(seen?: Array<{ url: string; headers: Record<string, string> }>): Connector;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the bridge');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function startBridges(): Promise<BridgeHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'gh-bridge-'));
  // The script resolves `ws` next to itself, as /opt/gh-bridge does in the template.
  const app = join(dir, 'app');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  copyFileSync(BRIDGE_SCRIPT, join(app, 'gh-bridge.mjs'));
  symlinkSync(realpathSync(WS_PACKAGE), join(app, 'node_modules', 'ws'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const leakFile = join(dir, 'leak');
  writeFileSync(
    join(bin, 'curl'),
    [
      '#!/bin/sh',
      'for last; do :; done',
      'leak=$(cat "$GH_TEST_LEAK_FILE" 2>/dev/null)',
      '[ -n "$leak" ] && [ "$last" = "$leak" ] && exit 0',
      'exit 7',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'curl'), 0o755);
  const sockets = join(dir, 'browser');
  mkdirSync(sockets, { mode: 0o700 });
  const servers: Server[] = [];
  for (const name of ['vnc.sock', 'cdp.sock']) {
    const server = createNetServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server.listen(join(sockets, name), resolve));
    servers.push(server);
  }
  const children: ChildProcess[] = [];
  async function bridge(name: string, extra: Record<string, string>): Promise<Bridge> {
    const port = await freePort();
    const secretFile = join(dir, `${name}.secret`);
    writeFileSync(secretFile, 'unset'.repeat(10), { mode: 0o600 });
    const ready = join(dir, `${name}.ready`);
    children.push(
      spawn(process.execPath, [join(app, 'gh-bridge.mjs')], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: dir,
          GH_BRIDGE_PORT: String(port),
          GH_BRIDGE_SECRET_FILE: secretFile,
          GH_BRIDGE_SOCKET_DIR: sockets,
          GH_BRIDGE_READY_FILE: ready,
          GH_TEST_LEAK_FILE: leakFile,
          GH_TEST_INHERITED: 'from-the-unit',
          ...extra,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      }),
    );
    await waitFor(() => existsSync(ready));
    return { port, secretFile };
  }
  const browser = await bridge('browser', { GH_BRIDGE_TUNNELS: '1' });
  const agent = await bridge('agent', {});
  return {
    dir,
    agent,
    browser,
    leakFile,
    setSecret: (target, secret) => writeFileSync(target.secretFile, secret, { mode: 0o600 }),
    connector: (seen) => (url, headers) => {
      seen?.push({ url, headers });
      const parsed = new URL(url);
      const port = parsed.hostname.startsWith('7681-')
        ? browser.port
        : parsed.hostname.startsWith('7682-')
          ? agent.port
          : 1;
      return new WebSocket(`ws://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, {
        headers,
        perMessageDeflate: false,
      });
    },
    async stop() {
      for (const child of children) child.kill('SIGKILL');
      for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
