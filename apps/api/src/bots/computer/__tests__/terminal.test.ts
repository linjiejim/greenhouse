/**
 * Terminal socket (terminal.ts) against fake sockets, a fake runtime and a
 * fake gh-term tunnel: the stdin framing gh-term reads (type u8, length u32
 * BE, payload; resize clamped), the protocol limits, the per-member cap, the
 * lifecycle shared with the viewer (pings, heartbeat, close on purge, nothing
 * left behind by a socket that closes mid-open), and the tunnel's argv.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { heartbeatViewer, execStream, ensureRunning } = vi.hoisted(() => ({
  heartbeatViewer: vi.fn<(userId: string) => Promise<void>>(async () => {}),
  execStream: vi.fn(),
  ensureRunning: vi.fn(async () => ({ container_name: 'c1', lease_controller: 'bot', lease_epoch: 3 })),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    botComputers: { heartbeatViewer, get: async () => undefined },
    users: { getById: async () => ({ id: 'u1', status: 'active', auth_version: 1, role: 'team' }) },
  }),
}));
vi.mock('../../../auth/features.js', () => ({ userHasFeature: async () => true }));
vi.mock('../lease-events.js', () => ({ onLeaseChange: vi.fn(() => () => {}) }));
vi.mock('../runtime.js', () => ({
  requireComputerRuntime: () => ({
    controller: { ensureRunning },
    host: { execStream },
    config: { proxy: 'http://proxy.internal:3128' },
  }),
}));

import type { WSContext } from 'hono/ws';
import { computerLifecycleHooks } from '../hooks.js';
import {
  closeTerminalsFor,
  MAX_INPUT_MESSAGE_BYTES,
  MAX_TERMINALS_PER_MEMBER,
  resizeFrame,
  terminalCount,
  terminalFrame,
  terminalSession,
  TERMINAL_FRAME,
} from '../terminal.js';
import { VIEWER_CLOSE } from '../viewer.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  send = vi.fn();
}

type FakeTunnel = EventEmitter & {
  stdout: EventEmitter & { pause(): void; resume(): void };
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; writableLength: number };
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
};

function fakeTunnel(): FakeTunnel {
  const tunnel = new EventEmitter() as FakeTunnel;
  tunnel.stdout = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() });
  tunnel.stderr = new EventEmitter();
  tunnel.stdin = { write: vi.fn(), end: vi.fn(), writableLength: 0 };
  tunnel.kill = vi.fn();
  tunnel.exitCode = null;
  tunnel.signalCode = null;
  return tunnel;
}

const claims = { uid: 'u1', av: 1, c: 'c1' };
const context = (socket: FakeSocket) => ({ raw: socket }) as unknown as WSContext;
const binary = (text: string) => new MessageEvent('message', { data: new TextEncoder().encode(text).buffer });
const text = (data: string) => new MessageEvent('message', { data });

/** Decode the frames written to gh-term's stdin. */
function frames(tunnel: FakeTunnel): Array<{ type: number; payload: string }> {
  const out: Array<{ type: number; payload: string }> = [];
  for (const [chunk] of tunnel.stdin.write.mock.calls as Array<[Buffer]>) {
    let offset = 0;
    while (offset < chunk.length) {
      const type = chunk.readUInt8(offset);
      const length = chunk.readUInt32BE(offset + 1);
      out.push({ type, payload: chunk.subarray(offset + 5, offset + 5 + length).toString('utf8') });
      offset += 5 + length;
    }
  }
  return out;
}

async function openTerminal(tunnel = fakeTunnel()) {
  execStream.mockReturnValueOnce(tunnel);
  const socket = new FakeSocket();
  const session = terminalSession(claims);
  await session.onOpen(new Event('open'), context(socket));
  return { socket, session, tunnel };
}

beforeEach(() => {
  vi.useFakeTimers();
  heartbeatViewer.mockReset().mockImplementation(async () => {});
  execStream.mockReset();
  ensureRunning.mockClear();
});

afterEach(() => {
  closeTerminalsFor('u1');
  vi.useRealTimers();
});

describe('gh-term framing', () => {
  it('frames bytes as type 0 and resizes as type 1 with a big-endian length', () => {
    const frame = terminalFrame(TERMINAL_FRAME.data, Buffer.from('ls\r'));
    expect([...frame]).toEqual([0, 0, 0, 0, 3, 0x6c, 0x73, 0x0d]);
    const resize = resizeFrame('{"type":"resize","cols":120,"rows":40}')!;
    expect(resize.readUInt8(0)).toBe(TERMINAL_FRAME.resize);
    expect(resize.readUInt32BE(1)).toBe(resize.length - 5);
    expect(JSON.parse(resize.subarray(5).toString())).toEqual({ cols: 120, rows: 40 });
  });

  it('clamps a resize to 10..500 × 5..200 and refuses anything that is not one', () => {
    const payload = (raw: string) => JSON.parse(resizeFrame(raw)!.subarray(5).toString());
    expect(payload('{"type":"resize","cols":1,"rows":1}')).toEqual({ cols: 10, rows: 5 });
    expect(payload('{"type":"resize","cols":99999,"rows":99999}')).toEqual({ cols: 500, rows: 200 });
    for (const bad of [
      'ls',
      '{"type":"input","data":"ls"}',
      '{"type":"resize","cols":"80","rows":24}',
      '{"type":"resize","cols":80.5,"rows":24}',
      '{"type":"resize","cols":80}',
      `{"type":"resize","cols":80,"rows":24,"pad":"${'x'.repeat(300)}"}`,
    ]) {
      expect(resizeFrame(bad), bad).toBeNull();
    }
  });
});

describe('terminal socket', () => {
  it('opens gh-term as uid agent, starts the computer if needed, and frames input', async () => {
    const { socket, session, tunnel } = await openTerminal();
    expect(ensureRunning).toHaveBeenCalledWith('u1', { allowOverQuota: true });
    // From the home: gh-term enters (and if needed recreates) ~/work itself.
    // The same identity and proxy as a Bot's shell call (BOTS_COMPUTER_PROXY).
    expect(execStream).toHaveBeenCalledWith('c1', 'agent', ['gh-term'], {
      cwd: '/home/agent',
      env: expect.objectContaining({
        HOME: '/home/agent',
        USER: 'agent',
        LOGNAME: 'agent',
        HTTPS_PROXY: 'http://proxy.internal:3128',
        NO_PROXY: 'localhost,127.0.0.1,::1',
      }),
    });
    expect(execStream.mock.calls[0]![3].env).not.toHaveProperty('GH_EXEC_ID');
    expect(heartbeatViewer).toHaveBeenCalledTimes(1);

    session.onMessage(binary('echo hi\r'));
    session.onMessage(text('{"type":"resize","cols":100,"rows":30}'));
    expect(frames(tunnel)).toEqual([
      { type: 0, payload: 'echo hi\r' },
      { type: 1, payload: '{"cols":100,"rows":30}' },
    ]);

    // Output goes back as binary.
    tunnel.stdout.emit('data', Buffer.from('hi\r\n'));
    expect(socket.send).toHaveBeenCalledWith(Buffer.from('hi\r\n'), { binary: true });
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('holds keystrokes typed while the computer starts, then sends them in order', async () => {
    let started!: () => void;
    ensureRunning.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          started = () => resolve({ container_name: 'c1', lease_controller: 'bot', lease_epoch: 3 });
        }),
    );
    const tunnel = fakeTunnel();
    execStream.mockReturnValueOnce(tunnel);
    const session = terminalSession(claims);
    const opening = session.onOpen(new Event('open'), context(new FakeSocket()));
    session.onMessage(binary('a'));
    session.onMessage(binary('b'));
    started();
    await opening;
    expect(frames(tunnel).map((f) => f.payload)).toEqual(['a', 'b']);
  });

  it('closes with 1008 on an unknown text message or an oversized one', async () => {
    const unknown = await openTerminal();
    unknown.session.onMessage(text('{"type":"input","data":"rm -rf ~"}'));
    expect(unknown.socket.close).toHaveBeenCalledWith(VIEWER_CLOSE.protocol, 'unknown message');
    expect(unknown.tunnel.stdin.write).not.toHaveBeenCalled();

    const flood = await openTerminal();
    flood.session.onMessage(new MessageEvent('message', { data: new ArrayBuffer(MAX_INPUT_MESSAGE_BYTES + 1) }));
    expect(flood.socket.close).toHaveBeenCalledWith(VIEWER_CLOSE.protocol, 'message too large');
  });

  it('allows four terminals per member; the fifth closes with 4009 too_many', async () => {
    const open = [];
    for (let i = 0; i < MAX_TERMINALS_PER_MEMBER; i++) open.push(await openTerminal());
    expect(terminalCount('u1')).toBe(4);
    const fifth = await openTerminal();
    expect(fifth.socket.close).toHaveBeenCalledWith(VIEWER_CLOSE.unavailable, 'too_many');
    expect(terminalCount('u1')).toBe(4);
    // One closes: room for another.
    open[0]!.session.onClose();
    expect(terminalCount('u1')).toBe(3);
    const again = await openTerminal();
    expect(again.socket.close).not.toHaveBeenCalled();
  });

  it('refuses a ticket issued for another container (the computer was rebuilt)', async () => {
    ensureRunning.mockResolvedValueOnce({ container_name: 'c2', lease_controller: 'bot', lease_epoch: 1 });
    const { socket } = await openTerminal();
    expect(socket.close).toHaveBeenCalledWith(VIEWER_CLOSE.unauthorized, 'stale ticket');
    expect(execStream).not.toHaveBeenCalled();
  });

  it('heartbeats every 20 s (keeps the computer awake) and drops a browser that misses a pong', async () => {
    const { socket, tunnel } = await openTerminal();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeatViewer).toHaveBeenCalledTimes(2);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); // no pong since the first ping
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    // Detached, not killed outright: gh-term gets EOF and the tmux session stays.
    expect(tunnel.stdin.end).toHaveBeenCalled();
    expect(tunnel.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tunnel.kill).toHaveBeenCalledWith('SIGKILL');
    const beats = heartbeatViewer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeatViewer.mock.calls.length).toBe(beats);
    expect(terminalCount('u1')).toBe(0);
  });

  it('leaves nothing behind when the socket closes while onOpen is still awaiting', async () => {
    let release!: () => void;
    heartbeatViewer.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const session = terminalSession(claims);
    const socket = new FakeSocket();
    const opening = session.onOpen(new Event('open'), context(socket));
    await vi.waitFor(() => expect(heartbeatViewer).toHaveBeenCalledTimes(1));
    session.onClose();
    release();
    await opening;
    expect(execStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(terminalCount('u1')).toBe(0);
  });

  it('closes on purge, and when gh-term ends (the shell exited or the computer stopped)', async () => {
    const purged = await openTerminal();
    computerLifecycleHooks.purged('u1');
    expect(purged.socket.close).toHaveBeenCalledWith(VIEWER_CLOSE.closedByServer, 'computer removed');

    const ended = await openTerminal();
    ended.tunnel.exitCode = 0;
    ended.tunnel.emit('exit', 0);
    expect(ended.socket.close).toHaveBeenCalledWith(VIEWER_CLOSE.tunnelClosed, 'terminal closed');
    expect(ended.tunnel.kill).not.toHaveBeenCalled(); // already gone
  });
});
