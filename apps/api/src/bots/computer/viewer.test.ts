/**
 * Live viewer socket lifecycle (viewer.ts) against fake sockets and a fake
 * runtime: a socket that closes while onOpen is still awaiting must leave
 * nothing behind (no tunnel, no lease listener, no heartbeat timer), and a
 * viewer whose browser stops answering pings is dropped instead of looking
 * live for the ~15 minutes TCP takes to give up.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { heartbeatViewer, execStream, unsubscribe, onLeaseChange } = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return {
    heartbeatViewer: vi.fn<(userId: string) => Promise<void>>(async () => {}),
    execStream: vi.fn(),
    unsubscribe,
    onLeaseChange: vi.fn(() => unsubscribe),
  };
});

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    botComputers: { heartbeatViewer, get: async () => undefined },
    users: { getById: async () => ({ id: 'u1', status: 'active', auth_version: 1, role: 'team' }) },
  }),
}));
vi.mock('../../auth/features.js', () => ({ userHasFeature: async () => true }));
vi.mock('./lease-events.js', () => ({ onLeaseChange }));
vi.mock('./runtime.js', () => ({
  requireComputerRuntime: () => ({
    controller: {
      ensureRunning: async () => ({ container_name: 'c1', lease_controller: 'bot', lease_epoch: 3 }),
    },
    docker: { execStream },
  }),
}));

import type { WSContext } from 'hono/ws';
import { viewerSession } from './viewer.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  send = vi.fn();
}

function fakeTunnel() {
  const tunnel = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { pause(): void; resume(): void };
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  tunnel.stdout = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() });
  tunnel.stderr = new EventEmitter();
  tunnel.stdin = { write: vi.fn() };
  tunnel.kill = vi.fn();
  return tunnel;
}

const claims = { uid: 'u1', av: 1, c: 'c1' };
const context = (socket: FakeSocket) => ({ raw: socket }) as unknown as WSContext;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  heartbeatViewer.mockReset().mockImplementation(async () => {});
  execStream.mockReset();
  onLeaseChange.mockClear();
  unsubscribe.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computer viewer socket', () => {
  it('leaves nothing behind when the socket closes while onOpen is still awaiting', async () => {
    let release!: () => void;
    heartbeatViewer.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const socket = new FakeSocket();
    const session = viewerSession(claims);

    const opening = session.onOpen(new Event('open'), context(socket));
    await flush();
    expect(heartbeatViewer).toHaveBeenCalledTimes(1); // parked on the first heartbeat
    session.onClose();
    release();
    await opening;

    expect(execStream).not.toHaveBeenCalled();
    expect(onLeaseChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatViewer).toHaveBeenCalledTimes(1); // no leaked 20 s heartbeat
    expect(socket.ping).not.toHaveBeenCalled();
  });

  it('drops a viewer that misses a pong (terminate, no more heartbeats), and keeps one that answers', async () => {
    const tunnel = fakeTunnel();
    execStream.mockReturnValue(tunnel);
    const silent = new FakeSocket();
    const session = viewerSession(claims);
    await session.onOpen(new Event('open'), context(silent));
    expect(execStream).toHaveBeenCalledWith('c1', 'browser', expect.any(Array));
    expect(onLeaseChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(silent.ping).toHaveBeenCalledTimes(1);
    expect(silent.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000); // no pong since the first ping
    expect(silent.terminate).toHaveBeenCalledTimes(1);
    expect(tunnel.kill).toHaveBeenCalledWith('SIGKILL');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const heartbeats = heartbeatViewer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeatViewer.mock.calls.length).toBe(heartbeats);

    // A browser answering every ping (its network stack does, even in a throttled tab) stays.
    execStream.mockReturnValue(fakeTunnel());
    const answering = new FakeSocket();
    answering.ping.mockImplementation(() => answering.emit('pong'));
    await viewerSession(claims).onOpen(new Event('open'), context(answering));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(answering.ping.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(answering.terminate).not.toHaveBeenCalled();
  });
});
