import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RealtimeEvent } from '@greenhouse/contract';
import { scriptedModel, text } from '../../engine/__tests__/model.js';
import { createTestApp } from '../../testing.js';
import { attachRealtime, CLOSE_UNAUTHORIZED } from '../socket.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function serve(app: ReturnType<typeof createTestApp>) {
  const server: Server = createServer(getRequestListener(app.app.fetch));
  const realtime = attachRealtime(server, { hub: app.services.hub, tokens: app.services.tokens, allowedOrigins: [] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
}

function open(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers });
  const events: RealtimeEvent[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (raw) => {
    events.push(JSON.parse(String(raw)) as RealtimeEvent);
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  const until = async (predicate: (all: RealtimeEvent[]) => boolean) => {
    while (!predicate(events)) await new Promise<void>((resolve) => waiters.push(resolve));
  };
  return { socket, events, closed, until, ready: new Promise<void>((resolve) => socket.on('open', () => resolve())) };
}

describe('the realtime socket', () => {
  it('signs in with the first frame and streams a reply as it is written', async () => {
    const model = scriptedModel([text('Streaming works.')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const url = await serve(app);
    const client = open(url);
    await client.ready;
    client.socket.send(JSON.stringify({ type: 'hello', data: { token: lin.token } }));
    await client.until((all) => all.some((event) => event.type === 'ready'));

    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    await app.call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: 'hi' } });
    await app.services.engine.idle();
    await client.until((all) => all.some((event) => event.type === 'message.updated'));
    const deltas = client.events
      .filter((event): event is Extract<RealtimeEvent, { type: 'message.delta' }> => event.type === 'message.delta')
      .map((event) => event.data.text)
      .join('');
    expect(deltas).toBe('Streaming works.');
    client.socket.close();
  });

  it('closes with 4401 on a bad token, and refuses a foreign page', async () => {
    const app = createTestApp();
    const url = await serve(app);
    const client = open(url);
    await client.ready;
    client.socket.send(JSON.stringify({ type: 'hello', data: { token: 'forged.token' } }));
    expect(await client.closed).toBe(CLOSE_UNAUTHORIZED);

    const foreign = new WebSocket(url, { headers: { origin: 'https://evil.example.com' } });
    const status = await new Promise<number>((resolve) =>
      foreign.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)),
    );
    expect(status).toBe(403);
  });
});
