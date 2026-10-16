/**
 * The screen, the terminal and the files against the real computer image on a real Docker
 * engine: the RFB handshake through the server's filter, a terminal round trip that survives a
 * reconnect (tmux), and a file going in, being listed, coming out and being deleted.
 *
 * Opt-in: GREENHOUSE_LIVE_DOCKER=1, with the computer image built (apps/bot-computer).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runDocker } from '@greenhouse/providers';
import { attachComputerSockets } from '../../../realtime/computer.js';
import { createTestApp } from '../../../testing.js';

const live = process.env.GREENHOUSE_LIVE_DOCKER === '1';
const IMAGE = process.env.GREENHOUSE_COMPUTER_IMAGE ?? 'greenhouse/bot-computer:latest';
const ENV = { SANDBOX_PROVIDER: 'docker', SANDBOX_IMAGE: IMAGE, SANDBOX_DOCKER_RUNTIME: 'runc' };

const sandboxes: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const name of sandboxes) {
    await runDocker(['rm', '-f', name]);
    await runDocker(['volume', 'rm', '-f', `${name}-home`]);
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A socket whose binary messages can be read as one byte stream. */
function connect(url: string) {
  const socket = new WebSocket(url);
  let buffer = Buffer.alloc(0);
  let closed: { code: number } | null = null;
  socket.on('message', (data) => {
    buffer = Buffer.concat([buffer, data as Buffer]);
  });
  socket.on('close', (code) => {
    closed = { code };
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  return {
    socket,
    opened,
    closed: () => closed,
    text: () => buffer.toString('utf8'),
    /** The next `n` bytes, or null once the socket closed without them. */
    async read(n: number, ms = 20_000): Promise<Buffer | null> {
      const deadline = Date.now() + ms;
      while (buffer.length < n) {
        if (closed || Date.now() > deadline) return null;
        await sleep(20);
      }
      const head = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      return head;
    },
    async until(predicate: (text: string) => boolean, ms = 20_000) {
      const deadline = Date.now() + ms;
      while (!predicate(buffer.toString('utf8'))) {
        if (closed || Date.now() > deadline) throw new Error(`no match in: ${buffer.toString('utf8').slice(-500)}`);
        await sleep(50);
      }
    },
  };
}

describe.skipIf(!live)('the computer, live', () => {
  it('serves its screen, a terminal that survives a reconnect, and its files', async () => {
    const app = createTestApp(ENV);
    const lin = await app.member();
    const agent = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
    sandboxes.push(`gh-cmp-${agent.id.toLowerCase()}`);
    const server: Server = createServer(getRequestListener(app.app.fetch));
    const sockets = attachComputerSockets(server, {
      computers: app.services.computers,
      hub: app.services.hub,
      allowedOrigins: [],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      await sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const socketFor = async (purpose: 'view' | 'control' | 'terminal') => {
      const issued = await app.call('POST', '/api/agents/main/computer/ticket', {
        token: lin.token,
        body: { purpose },
      });
      expect(issued.status).toBe(200);
      return connect(
        `${base}/api/ws/${purpose === 'terminal' ? 'computer-terminal' : 'computer'}?ticket=${issued.body.ticket}`,
      );
    };

    // 1. The screen: taking over starts the computer; the display comes up a few seconds later.
    const name = `gh-cmp-${agent.id.toLowerCase()}`;
    const openScreen = async (purpose: 'view' | 'control') => {
      let screen = await socketFor(purpose);
      let version = await screen.read(12);
      for (let attempt = 0; !version && attempt < 20; attempt++) {
        await sleep(1000);
        screen = await socketFor(purpose);
        version = await screen.read(12);
      }
      expect(version?.toString('latin1')).toBe('RFB 003.008\n');
      screen.socket.send(version!);
      const count = (await screen.read(1))!.readUInt8(0);
      expect([...(await screen.read(count))!]).toContain(1);
      screen.socket.send(Buffer.from([1]));
      expect((await screen.read(4))!.readUInt32BE(0)).toBe(0);
      screen.socket.send(Buffer.from([0]));
      const init = (await screen.read(24))!;
      expect([init.readUInt16BE(0), init.readUInt16BE(2)]).toEqual([1280, 800]);
      expect((await screen.read(init.readUInt32BE(20)))!.toString()).toBe('greenhouse');
      return screen;
    };
    /** Moves the pointer, then waits for the display to answer a request sent after it. */
    const moveTo = async (screen: ReturnType<typeof connect>, x: number, y: number) => {
      const move = Buffer.from([5, 0, x >> 8, x & 255, y >> 8, y & 255]);
      const update = Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
      screen.socket.send(Buffer.concat([move, update]));
      expect((await screen.read(1))?.[0]).toBe(0);
    };
    const pointer = async () =>
      (
        await runDocker([
          'exec',
          '-u',
          'browser',
          '-e',
          'DISPLAY=:0',
          '-e',
          'XAUTHORITY=/home/browser/.Xauthority',
          name,
          'xdotool',
          'getmouselocation',
        ])
      ).stdout;
    const control = await openScreen('control');
    await moveTo(control, 321, 123);
    expect(await pointer()).toMatch(/^x:321 y:123 /);
    // Watching cannot move it: the server dropped the event, whatever the page said.
    const watcher = await openScreen('view');
    await moveTo(watcher, 100, 50);
    expect(await pointer()).toMatch(/^x:321 y:123 /);
    control.socket.close();
    watcher.socket.close();

    // 2. The terminal: a command and its output, then a reconnect lands in the same shell.
    const terminal = await socketFor('terminal');
    await terminal.opened;
    terminal.socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    terminal.socket.send(Buffer.from('export GH_MARK=kept; echo hello-$((6*7))\r'));
    await terminal.until((text) => text.includes('hello-42'));
    terminal.socket.close();
    await sleep(500);
    const again = await socketFor('terminal');
    await again.opened;
    again.socket.send(Buffer.from('echo mark-$GH_MARK\r'));
    await again.until((text) => text.includes('mark-kept'));
    again.socket.close();

    // 3. Files: in, listed, out, deleted; a link out of the home is refused.
    const form = new FormData();
    form.set('file', new File(['live bytes'], 'live.txt'));
    const uploaded = await app.app.request('/api/agents/main/computer/files?path=work', {
      method: 'POST',
      headers: { authorization: `Bearer ${lin.token}` },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({ name: 'live.txt', type: 'file', size: 10 });
    const second = await app.app.request('/api/agents/main/computer/files?path=work', {
      method: 'POST',
      headers: { authorization: `Bearer ${lin.token}` },
      body: form,
    });
    expect(await second.json()).toMatchObject({ name: 'live (1).txt' });
    const listed = await app.call('GET', '/api/agents/main/computer/files?path=work', { token: lin.token });
    expect(listed.body.items.map((item: { name: string }) => item.name)).toEqual(
      expect.arrayContaining(['live.txt', 'live (1).txt']),
    );
    const home = await app.call('GET', '/api/agents/main/computer/files', { token: lin.token });
    expect(home.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'work', type: 'dir' })]));
    const content = await app.app.request('/api/agents/main/computer/files/content?path=work/live.txt', {
      headers: { authorization: `Bearer ${lin.token}` },
    });
    expect(content.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(await content.text()).toBe('live bytes');
    await app.services.computers.shell(lin.id, 'main', 'ln -sfn /etc ~/work/etc-link');
    const escape = await app.call('GET', '/api/agents/main/computer/files?path=work/etc-link', {
      token: lin.token,
    });
    expect(escape.body.error.code).toBe('path_outside_home');
    expect(
      (await app.call('DELETE', '/api/agents/main/computer/files?path=work', { token: lin.token })).body.error.code,
    ).toBe('invalid_input');
    for (const name of ['live.txt', 'live (1).txt', 'etc-link']) {
      const removed = await app.call(
        'DELETE',
        `/api/agents/main/computer/files?path=work/${encodeURIComponent(name)}`,
        {
          token: lin.token,
        },
      );
      expect(removed.status).toBe(204);
    }
    expect((await app.services.computers.shell(lin.id, 'main', 'ls /etc/hostname && ls ~/work')).output).toBe(
      '/etc/hostname\n',
    );
  }, 180_000);
});
