/** The shared API client against the real app: the same calls the web app makes. */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent, TokenPair } from '@greenhouse/contract';
import { createApiClient } from '@greenhouse/contract/client';
import { attachRealtime } from '../realtime/socket.js';
import { createTestApp, TEST_PASSWORD } from '../testing.js';
import { scriptedModel, text } from '../engine/__tests__/model.js';

describe('the API client against the app', () => {
  it('signs in, reads the workspace, talks to the main Agent and survives an expired access token', async () => {
    const model = scriptedModel([text('Hello, Lin.')]);
    const { app, services, member } = createTestApp({}, { languageModel: model.languageModel });
    const lin = await member('member', 'lin@example.com');
    let stored: TokenPair | null = null;
    const client = createApiClient({
      baseUrl: '',
      tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
      fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    });

    expect((await client.bootstrap()).api_version).toBe(2);
    await client.auth.login('lin@example.com', TEST_PASSWORD);
    expect((await client.me.get()).id).toBe(lin.id);

    const main = (await client.conversations.list({ kind: 'main' })).items[0]!;
    const sent = await client.conversations.send(main.id, { content: 'hi' });
    await services.engine.idle();
    const messages = await client.conversations.messages(main.id);
    const reply = messages.items.find((message) => message.run_id === sent.run_id);
    expect(reply).toMatchObject({ role: 'assistant', status: 'complete', content: 'Hello, Lin.' });
    // Turns are not background runs: the Runs page never lists them.
    await expect(client.runs.get(sent.run_id!)).rejects.toMatchObject({ status: 404 });

    // The access token goes bad; the client refreshes with the stored refresh token and retries.
    stored = { ...stored!, access_token: 'expired' };
    expect((await client.agents.list()).items.map((agent) => agent.is_main)).toContain(true);
    expect(stored!.access_token).not.toBe('expired');

    await expect(client.agents.get('nobody')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await client.auth.logout();
    expect(stored).toBeNull();
  });

  it('reaches every conversation action the web app uses', async () => {
    const model = scriptedModel([text('First.'), text('Second.'), text('Third.')]);
    const { app, services, member } = createTestApp({}, { languageModel: model.languageModel });
    const lin = await member('member', 'lin@example.com');
    const chen = await member('member', 'chen@example.com');
    let stored: TokenPair | null = null;
    const client = createApiClient({
      baseUrl: '',
      tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
      fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    });
    await client.auth.login('lin@example.com', TEST_PASSWORD);

    const main = (await client.conversations.list({ kind: 'main' })).items[0]!;
    const sent = await client.conversations.send(main.id, { content: 'hi' });
    await services.engine.idle();
    const reply = (await client.conversations.messages(main.id)).items.at(-1)!;
    expect(await client.conversations.rate(main.id, reply.id, { rating: 1 })).toEqual({ rating: 1, comment: '' });
    expect((await client.conversations.messages(main.id)).items.at(-1)!.my_rating).toBe(1);
    const edited = await client.conversations.edit(main.id, sent.message.id, 'hello');
    expect(edited.deleted_message_ids).toEqual([reply.id]);
    await services.engine.idle();
    const again = (await client.conversations.messages(main.id)).items.at(-1)!;
    expect((await client.conversations.regenerate(main.id, again.id)).deleted_message_ids).toEqual([again.id]);
    await services.engine.idle();
    expect((await client.conversations.messages(main.id)).items.at(-1)!.content).toBe('Third.');

    const room = await client.conversations.create({ kind: 'room', title: 'Plans' });
    expect((await client.conversations.addMembers(room.id, { member_ids: [chen.id] })).members).toHaveLength(2);
    await client.conversations.removeMember(room.id, chen.id);
    expect((await client.conversations.members(room.id)).members.map((person) => person.id)).toEqual([lin.id]);
    const note = await client.conversations.addNote(room.id, { title: 'Agenda' });
    expect((await client.conversations.updateNote(room.id, note.id, { status: 'done' })).status).toBe('done');
    expect((await client.conversations.notes(room.id)).items).toHaveLength(1);
    await client.conversations.removeNote(room.id, note.id);
    expect((await client.conversations.export(room.id)).filename).toBe('Plans.md');
    expect((await client.search({ q: 'plans', kinds: ['conversations'] })).items[0]!.id).toBe(room.id);
    expect((await client.members.directory('chen')).items.map((person) => person.id)).toEqual([chen.id]);
    expect((await client.me.get()).capabilities.storage).toBe(true);
  });

  it('keeps the realtime socket signed in across an expired access token', async () => {
    const model = scriptedModel([text('Over the socket.')]);
    const app = createTestApp({}, { languageModel: model.languageModel });
    await app.member('member', 'mei@example.com');
    const server = createServer(getRequestListener(app.app.fetch));
    const realtime = attachRealtime(server, { hub: app.services.hub, tokens: app.services.tokens, allowedOrigins: [] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let stored: TokenPair | null = null;
    const client = createApiClient({ baseUrl, tokens: { get: () => stored, set: (tokens) => (stored = tokens) } });
    try {
      await client.auth.login('mei@example.com', TEST_PASSWORD);
      stored = { ...stored!, access_token: 'expired' };
      const events: RealtimeEvent[] = [];
      let ready = false;
      const connection = client.connect(
        { onEvent: (event) => events.push(event), onReady: () => (ready = true) },
        { minDelayMs: 10, maxDelayMs: 50 },
      );
      await expect.poll(() => ready, { timeout: 5_000 }).toBe(true);
      expect(stored!.access_token).not.toBe('expired');

      const main = (await client.conversations.list({ kind: 'main' })).items[0]!;
      await client.conversations.send(main.id, { content: 'hi' });
      await app.services.engine.idle();
      await expect.poll(() => events.some((event) => event.type === 'message.updated'), { timeout: 5_000 }).toBe(true);
      const streamed = events.flatMap((event) => (event.type === 'message.delta' ? [event.data.text] : [])).join('');
      expect(streamed).toBe('Over the socket.');
      connection.close();
    } finally {
      await realtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
