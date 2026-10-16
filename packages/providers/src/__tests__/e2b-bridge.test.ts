/**
 * The bridge client (sandbox/e2b/bridge.ts) against the real gh-bridge on loopback: the secret at
 * the door, exit codes, bytes both ways, the output cap, the deadline, kill and the tunnels.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BridgeStream, bridgeRun, type BridgeMode, type BridgeTarget } from '../sandbox/e2b/bridge.js';
import { startBridges, type BridgeHarness } from './gh-bridge-harness.js';

const SECRET = randomBytes(32).toString('hex');
let bridges: BridgeHarness;

beforeAll(async () => {
  bridges = await startBridges();
  bridges.setSecret(bridges.agent, SECRET);
  bridges.setSecret(bridges.browser, SECRET);
});

afterAll(async () => {
  await bridges?.stop();
});

const target = (port: 7681 | 7682, secret = SECRET): Promise<BridgeTarget> =>
  Promise.resolve({ url: `wss://${port}-sbx1.e2b.test`, headers: { 'x-gh-bridge-secret': secret } });

const open = (mode: BridgeMode, port: 7681 | 7682 = 7682, secret = SECRET) =>
  new BridgeStream(target(port, secret), mode, bridges.connector());

const exec = (argv: string[], options: { input?: Uint8Array; deadlineMs?: number; maxOutputBytes?: number } = {}) =>
  bridgeRun(open({ kind: 'exec', argv }), {
    deadlineMs: options.deadlineMs ?? 10_000,
    maxOutputBytes: options.maxOutputBytes ?? 1 << 20,
    ...(options.input ? { input: options.input } : {}),
  });

/** Everything a stream writes until it ends. */
function collect(stream: BridgeStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  stream.output.on('data', (chunk: Buffer) => parts.push(chunk));
  return stream.exited.then(() => Buffer.concat(parts));
}

describe('the gh-bridge client', () => {
  it('keeps a busy transfer alive when pongs are behind its output, then detects a dead connection', async () => {
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
    });
    const stream = new BridgeStream(
      target(7682),
      { kind: 'exec', argv: ['cat'] },
      () => socket as unknown as WebSocket,
    );
    stream.output.resume();
    try {
      await Promise.resolve();
      socket.emit('open');
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
        if (i % 2) socket.emit('ping');
        else socket.emit('message', Buffer.from([1, 42]), true);
      }
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(socket.send).toHaveBeenCalledWith('{"t":"ping"}');
      await vi.advanceTimersByTimeAsync(40_000);
      expect(socket.terminate).toHaveBeenCalledOnce();
      expect(stream.failure?.message).toBe('The computer stopped answering');
    } finally {
      stream.kill();
      vi.useRealTimers();
    }
  });

  it('still sends keepalives while its output reader is paused', async () => {
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: vi.fn(),
      ping: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      terminate: vi.fn(),
    });
    const stream = new BridgeStream(
      target(7682),
      { kind: 'exec', argv: ['cat'] },
      () => socket as unknown as WebSocket,
    );
    try {
      await Promise.resolve();
      socket.emit('open');
      socket.emit('message', Buffer.concat([Buffer.from([1]), Buffer.alloc(128 * 1024)]), true);
      expect(stream.output.readableLength).toBe(128 * 1024);
      expect(socket.pause).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.send.mock.calls.filter(([value]) => value === '{"t":"ping"}')).toHaveLength(3);
      expect(socket.terminate).not.toHaveBeenCalled();
    } finally {
      socket.emit('close', 1000);
      vi.useRealTimers();
    }
  });

  it('is refused without the secret, with a wrong one, and the error keeps the status', async () => {
    for (const secret of ['', 'x'.repeat(64)]) {
      const stream = open({ kind: 'exec', argv: ['true'] }, 7682, secret);
      await expect(bridgeRun(stream, { deadlineMs: 5_000, maxOutputBytes: 1024 })).rejects.toMatchObject({
        name: 'BridgeError',
        status: 403,
      });
      expect(await stream.exited).toBeNull();
    }
  });

  it('runs a command: stdout, stderr and the exit code apart, in the unit’s environment', async () => {
    const result = await exec(['sh', '-c', 'echo "out $GH_TEST_INHERITED"; echo err >&2; exit 3']);
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out from-the-unit\n', stderr: 'err\n', timedOut: false });
    // The bridge's own settings never reach a command.
    expect((await exec(['env'])).stdout).not.toMatch(/GH_BRIDGE_/);
  });

  it('carries binary input and output intact, megabytes of it', async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const stream = open({ kind: 'exec', argv: ['cat'] });
    const echoed = collect(stream);
    stream.input.end(bytes);
    expect((await echoed).equals(bytes)).toBe(true);
    expect(await stream.exited).toBe(0);
  });

  it('caps the output it keeps and still reports the exit', async () => {
    const result = await exec(['sh', '-c', 'head -c 300000 /dev/zero; exit 0'], { maxOutputBytes: 1000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(1000);
  });

  it.each([1, 32])(
    'keeps the server alive with pongs behind a %i MiB download at a slow reader',
    async (size) => {
      const slow = await startBridges({ fastHeartbeat: true });
      slow.setSecret(slow.agent, SECRET);
      const socket = slow.connector()('wss://7682-sbx1.e2b.test/exec', { 'x-gh-bridge-secret': SECRET });
      let bytes = 0;
      let code: number | undefined;
      let held = false;
      const ping = setInterval(() => {
        if (socket.readyState === 1) socket.send('{"t":"ping"}');
      }, 50);
      try {
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        socket.on('message', (raw, binary) => {
          const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
          if (!binary) {
            const message = JSON.parse(data.toString());
            if (message.t === 'exit') code = message.code;
            return;
          }
          bytes += data.length - 1;
          if (!held) {
            held = true;
            socket.pause();
            setTimeout(() => socket.resume(), 600);
          }
        });
        await new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve());
          socket.once('error', reject);
        });
        socket.send(JSON.stringify({ argv: ['head', '-c', String(size * 1024 * 1024), '/dev/zero'] }));
        socket.send(JSON.stringify({ t: 'eof' }));
        await closed;
        expect(code).toBe(0);
        expect(bytes).toBe(size * 1024 * 1024);
      } finally {
        clearInterval(ping);
        socket.terminate();
        await slow.stop();
      }
    },
    30_000,
  );

  it('kills a command past its deadline, and on kill ends with no exit code', async () => {
    const started = Date.now();
    const late = await exec(['sleep', '30'], { deadlineMs: 300 });
    expect(late).toMatchObject({ timedOut: true, exitCode: -1 });
    expect(Date.now() - started).toBeLessThan(5_000);

    const stream = open({ kind: 'exec', argv: ['sleep', '30'] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stream.kill();
    expect(await stream.exited).toBeNull();
  });

  it('reports what a command that cannot run would, like a failed docker exec', async () => {
    expect((await exec(['/nonexistent/binary'])).exitCode).toBe(127);
    const missingDir = await bridgeRun(open({ kind: 'exec', argv: ['true'], cwd: '/nonexistent' }), {
      deadlineMs: 5_000,
      maxOutputBytes: 1024,
    });
    expect(missingDir.exitCode).toBe(126);
  });

  it('tunnels raw bytes to the screen and DevTools sockets; ending the input ends the tunnel', async () => {
    for (const path of ['/vnc', '/cdp'] as const) {
      const stream = open({ kind: 'tunnel', path }, 7681);
      const bytes = randomBytes(200_000);
      const parts: Buffer[] = [];
      stream.output.on('data', (chunk: Buffer) => parts.push(chunk));
      stream.input.write(bytes);
      const deadline = Date.now() + 5_000;
      while (Buffer.concat(parts).length < bytes.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(Buffer.concat(parts).equals(bytes)).toBe(true);
      stream.input.end();
      expect(await stream.exited).toBe(0);
    }
  });

  it('never opens a tunnel on the agent bridge', async () => {
    const stream = open({ kind: 'tunnel', path: '/vnc' }, 7682);
    expect(await stream.exited).toBeNull();
    expect(stream.failure?.status).toBe(403);
  });

  it('answers data-frame keepalives without forwarding them into a tunnel', async () => {
    const socket = bridges.connector()('wss://7681-sbx1.e2b.test/vnc', { 'x-gh-bridge-secret': SECRET });
    const bytes = randomBytes(1024);
    const parts: Buffer[] = [];
    try {
      const pong = new Promise<void>((resolve) =>
        socket.on('message', (data, binary) => {
          if (binary) parts.push(Buffer.from(data as Buffer));
          else if (data.toString() === '{"t":"pong"}') resolve();
        }),
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send('{"t":"ping"}');
      socket.send(bytes);
      await pong;
      await expect.poll(() => Buffer.concat(parts).length).toBe(bytes.length);
      expect(Buffer.concat(parts).equals(bytes)).toBe(true);
    } finally {
      socket.terminate();
    }
  });

  it('fails a stream whose target never resolves, with the reason on its errors', async () => {
    const stream = new BridgeStream(
      Promise.reject(new Error('The computer is not running.')),
      { kind: 'exec', argv: ['true'] },
      bridges.connector(),
    );
    const errors: Buffer[] = [];
    stream.errors.on('data', (chunk: Buffer) => errors.push(chunk));
    expect(await stream.exited).toBeNull();
    expect(Buffer.concat(errors).toString()).toContain('The computer is not running.');
  });
});
