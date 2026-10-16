/**
 * The screen and terminal sockets on a real HTTP server, against the in-memory sandbox: tickets
 * (one use, one socket, one member, a minute, stored hashed), view-only enforced on the server,
 * the terminal's framing, and sockets closing when the computer stops.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { COMPUTER_SOCKET_CLOSE, type RealtimeEvent } from '@greenhouse/contract';
import { agentComputers, getDb, idempotencyKeys, members } from '@greenhouse/db';
import { attachComputerSockets } from '../../../realtime/computer.js';
import { createTestApp } from '../../../testing.js';
import { resizeFrame, TERMINAL_FRAME, terminalFrame } from '../terminal.js';
import { fake, fakeSandboxEnv, type FakeStream } from './fake-sandbox.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | undefined | false, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(10);
  }
}

async function setup() {
  const app = createTestApp(fakeSandboxEnv());
  const lin = await app.member();
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
  const ticket = async (purpose: 'view' | 'control' | 'terminal', token = lin.token, agent = 'main') =>
    app.call('POST', `/api/agents/${agent}/computer/ticket`, { token, body: { purpose } });
  return { ...app, lin, base, ticket };
}

function connect(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers });
  const received: Buffer[] = [];
  socket.on('message', (data) => received.push(Buffer.from(data as Buffer)));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const opened = new Promise<void>((resolve) => socket.on('open', () => resolve()));
  return { socket, received, closed, opened, text: () => Buffer.concat(received).toString('utf8') };
}

const VERSION = Buffer.from('RFB 003.008\n');
const HANDSHAKE = Buffer.concat([VERSION, Buffer.from([1, 0])]);
const FB_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const keyEvent = (down: boolean, keysym: number) => {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = down ? 1 : 0;
  b.writeUInt32BE(keysym, 4);
  return b;
};
const pointer = (mask: number, x: number, y: number) => {
  const b = Buffer.alloc(6);
  b[0] = 5;
  b[1] = mask;
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  return b;
};
const cutText = (text: string) => {
  const head = Buffer.alloc(8);
  head[0] = 6;
  head.writeInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([head, Buffer.from(text)]);
};
const screens = () => fake.streams.filter((stream) => stream.kind === 'screen');

describe('the computer screen socket', () => {
  it('is view-only on the server for a view ticket, and passes input on a control ticket', async () => {
    const { call, lin, base, ticket } = await setup();
    expect((await ticket('view')).body.error.code).toBe('computer_not_running');
    await call('POST', '/api/agents/main/computer/start', { token: lin.token });

    const view = (await ticket('view')).body;
    expect(view).toEqual({ ticket: expect.any(String), expires_at: expect.any(String) });
    expect(Date.parse(view.expires_at) - Date.now()).toBeLessThanOrEqual(60_000);
    // Only a keyed hash of the ticket is kept.
    const stored = await getDb().select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, 'computer_ticket'));
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(view.ticket);
    expect(stored[0]!.response).toMatchObject({ member_id: lin.id, purpose: 'view' });

    const watcher = connect(`${base}/api/ws/computer?ticket=${view.ticket}`);
    await watcher.opened;
    const screen = await waitFor(() => screens()[0]);
    screen.output.write(VERSION);
    await waitFor(() => watcher.text() === VERSION.toString());
    // The handshake byte by byte, then keys, a click and a paste between two screen requests.
    for (const byte of HANDSHAKE) watcher.socket.send(Buffer.from([byte]));
    watcher.socket.send(
      Buffer.concat([FB_REQUEST, keyEvent(true, 0x61), pointer(1, 5, 5), cutText('rm -rf ~'), FB_REQUEST]),
    );
    const expected = Buffer.concat([VERSION, Buffer.from([1, 1]), FB_REQUEST, FB_REQUEST]);
    await waitFor(() => screen.written().length >= expected.length);
    await sleep(30);
    expect(screen.written()).toEqual(expected);
    // A view socket speaks binary only.
    watcher.socket.send('hello');
    expect((await watcher.closed).code).toBe(1008);

    // Spent once: the same ticket again is refused.
    const again = connect(`${base}/api/ws/computer?ticket=${view.ticket}`);
    expect((await again.closed).code).toBe(COMPUTER_SOCKET_CLOSE.ticket);

    const control = connect(`${base}/api/ws/computer?ticket=${(await ticket('control')).body.ticket}`);
    await control.opened;
    const taken = await waitFor(() => screens()[1]);
    control.socket.send(Buffer.concat([HANDSHAKE, keyEvent(true, 0x61), pointer(1, 5, 5), FB_REQUEST]));
    const input = Buffer.concat([VERSION, Buffer.from([1, 1]), keyEvent(true, 0x61), pointer(1, 5, 5), FB_REQUEST]);
    await waitFor(() => taken.written().length >= input.length);
    expect(taken.written()).toEqual(input);
    // Leaving mid-press lets go of the key and the button.
    control.socket.close();
    await taken.exited;
    expect(taken.written().subarray(input.length)).toEqual(Buffer.concat([keyEvent(false, 0x61), pointer(0, 5, 5)]));
  });

  it('refuses a ticket for the other socket, a forged or expired one, another member and a foreign page', async () => {
    const { call, lin, member, base, ticket } = await setup();
    await call('POST', '/api/agents/main/computer/start', { token: lin.token });

    const terminalTicket = (await ticket('terminal')).body.ticket;
    expect((await connect(`${base}/api/ws/computer?ticket=${terminalTicket}`).closed).code).toBe(4401);
    const viewTicket = (await ticket('view')).body.ticket;
    expect((await connect(`${base}/api/ws/computer-terminal?ticket=${viewTicket}`).closed).code).toBe(4401);
    expect((await connect(`${base}/api/ws/computer?ticket=forged`).closed).code).toBe(4401);
    expect((await connect(`${base}/api/ws/computer`).closed).code).toBe(4401);

    const late = (await ticket('view')).body.ticket;
    await getDb()
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(idempotencyKeys.scope, 'computer_ticket'));
    expect((await connect(`${base}/api/ws/computer?ticket=${late}`).closed).code).toBe(4401);

    // Only the member whose computer it is gets a ticket.
    const chen = await member();
    const main = (await call('GET', '/api/agents/main', { token: lin.token })).body;
    expect((await ticket('view', chen.token, main.id)).status).toBe(404);
    expect((await call('POST', `/api/agents/main/computer/ticket`, { token: lin.token, body: {} })).status).toBe(400);

    // Signing in again elsewhere (a new password) spends tickets made before.
    const before = (await ticket('view')).body.ticket;
    await getDb()
      .update(members)
      .set({ authVersion: lin.authVersion + 1 })
      .where(eq(members.id, lin.id));
    expect((await connect(`${base}/api/ws/computer?ticket=${before}`).closed).code).toBe(
      COMPUTER_SOCKET_CLOSE.forbidden,
    );

    const foreign = new WebSocket(`${base}/api/ws/computer?ticket=x`, {
      headers: { origin: 'https://evil.example.com' },
    });
    const status = await new Promise<number>((resolve) =>
      foreign.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)),
    );
    expect(status).toBe(403);
  });
});

describe('the computer terminal socket', () => {
  it('runs gh-term as the agent: keystrokes and resizes in, output out, and it starts the computer', async () => {
    const { lin, base, ticket, services } = await setup();
    const issued = await ticket('terminal');
    expect(issued.status).toBe(200);
    const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.ownerId, lin.id));
    expect(row!.state).toBe('running');

    const terminal = connect(`${base}/api/ws/computer-terminal?ticket=${issued.body.ticket}`);
    await terminal.opened;
    // Sent before the computer's side is open: kept, then delivered in order.
    terminal.socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 9000 }));
    terminal.socket.send(Buffer.from('echo hello\r'));
    const shell = await waitFor(() => fake.streams.find((stream: FakeStream) => stream.argv[0] === 'gh-term'));
    expect(shell).toMatchObject({ kind: 'stream', cwd: '/home/agent' });
    const expected = Buffer.concat([
      resizeFrame(JSON.stringify({ type: 'resize', cols: 120, rows: 9000 }))!,
      terminalFrame(TERMINAL_FRAME.data, Buffer.from('echo hello\r')),
    ]);
    await waitFor(() => shell.written().length >= expected.length);
    expect(shell.written()).toEqual(expected);
    expect(JSON.parse(expected.subarray(5, expected.readUInt32BE(1) + 5).toString())).toEqual({ cols: 120, rows: 200 });

    shell.output.write('hello\r\n');
    await waitFor(() => terminal.text().includes('hello'));

    // Stopping the computer closes it, from whichever API process stopped it (the hub).
    const events: RealtimeEvent[] = [];
    services.hub.subscribe(lin.id, (event) => events.push(event));
    const stopped = await services.computers.stop(lin.id, 'main');
    expect(stopped.state).toBe('stopped');
    expect((await terminal.closed).code).toBe(COMPUTER_SOCKET_CLOSE.stopped);
    expect(events).toContainEqual({ type: 'computer.updated', data: { agent_id: row!.agentId, state: 'stopped' } });
    // Its input ended, so gh-term detached and the shell stays in tmux.
    expect(await shell.exited).toBe(0);
  });

  it('closes on a message it does not take, and keeps the computer awake while open', async () => {
    const { base, ticket, lin } = await setup();
    const issued = (await ticket('terminal')).body.ticket;
    await getDb()
      .update(agentComputers)
      .set({ lastActiveAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(agentComputers.ownerId, lin.id));
    const terminal = connect(`${base}/api/ws/computer-terminal?ticket=${issued}`);
    await terminal.opened;
    await waitFor(() => fake.streams.find((stream) => stream.argv[0] === 'gh-term'));
    const recent = async () => {
      const [row] = await getDb().select().from(agentComputers).where(eq(agentComputers.ownerId, lin.id));
      return Date.now() - Date.parse(row!.lastActiveAt!) < 60_000;
    };
    for (let tries = 0; !(await recent()) && tries < 100; tries++) await sleep(10);
    expect(await recent()).toBe(true);
    terminal.socket.send('{"type":"paste","text":"x"}');
    expect((await terminal.closed).code).toBe(1008);
  });
});
