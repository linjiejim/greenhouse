import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import * as wsModule from 'ws';

import { openCdpBridge } from './cdp-bridge.js';

const WsClient = (wsModule.WebSocket ??
  (wsModule as unknown as { default: typeof wsModule }).default.WebSocket) as typeof wsModule.WebSocket;

/** A stand-in for `docker exec -i … socat`: NUL-framed pipe protocol on stdio. */
function fakeTunnel() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn(() => true) });
  return { child, stdin, stdout };
}

function connect(url: string): Promise<{ socket: wsModule.WebSocket; opened: boolean; code?: number }> {
  return new Promise((resolve) => {
    const socket = new WsClient(url);
    socket.once('open', () => resolve({ socket, opened: true }));
    socket.once('error', () => resolve({ socket, opened: false }));
    socket.once('unexpected-response', () => resolve({ socket, opened: false }));
  });
}

describe('CDP bridge', () => {
  it('refuses any path but the secret one without spawning docker', async () => {
    const spawnTunnel = vi.fn(() => fakeTunnel().child);
    const bridge = await openCdpBridge({ spawnTunnel, secret: 'a'.repeat(32) });
    try {
      expect(bridge.url).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:\\d+/${'a'.repeat(32)}/devtools/browser$`));
      const origin = bridge.url.replace(/\/[^/]+\/devtools\/browser$/, '');
      for (const path of [
        '/devtools/browser',
        `/${'b'.repeat(32)}/devtools/browser`,
        `/${'a'.repeat(31)}/devtools/browser`,
        '/json/version',
      ]) {
        expect((await connect(`${origin}${path}`)).opened).toBe(false);
      }
      const http = await fetch(`${origin.replace('ws:', 'http:')}/json/version`);
      expect(http.status).toBe(404);
      expect(spawnTunnel).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('converts WebSocket frames to NUL-delimited pipe messages and back, one client only', async () => {
    const tunnel = fakeTunnel();
    const spawnTunnel = vi.fn(() => tunnel.child);
    const onClose = vi.fn();
    const bridge = await openCdpBridge({ spawnTunnel, onClose });
    const { socket, opened } = await connect(bridge.url);
    expect(opened).toBe(true);
    expect(spawnTunnel).toHaveBeenCalledTimes(1);

    const written: Buffer[] = [];
    tunnel.stdin.on('data', (chunk: Buffer) => written.push(chunk));
    socket.send('{"id":1,"method":"Browser.getVersion"}');
    await vi.waitFor(() => expect(Buffer.concat(written).toString()).toBe('{"id":1,"method":"Browser.getVersion"}\0'));

    const received: string[] = [];
    socket.on('message', (data: Buffer) => received.push(data.toString()));
    // Two messages, the second split across chunks.
    tunnel.stdout.write('{"id":1,"result":{}}\0{"method":"Target.target');
    tunnel.stdout.write('Created","params":{}}\0');
    await vi.waitFor(() =>
      expect(received).toEqual(['{"id":1,"result":{}}', '{"method":"Target.targetCreated","params":{}}']),
    );

    expect((await connect(bridge.url)).opened).toBe(false); // a second client is refused
    expect(spawnTunnel).toHaveBeenCalledTimes(1);

    socket.close();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(tunnel.child.kill).toHaveBeenCalled();
  });

  it('closes the client when the tunnel dies', async () => {
    const tunnel = fakeTunnel();
    const onClose = vi.fn();
    const bridge = await openCdpBridge({ spawnTunnel: () => tunnel.child, onClose });
    const { socket } = await connect(bridge.url);
    const closed = new Promise<number>((resolve) => socket.once('close', (code: number) => resolve(code)));
    tunnel.child.emit('exit', 1, null);
    expect(await closed).toBe(1011);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
