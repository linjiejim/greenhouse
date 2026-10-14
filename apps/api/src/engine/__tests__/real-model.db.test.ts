/**
 * The whole path with no stand-ins inside the API: an OpenAI-compatible server on loopback
 * (configured like any env instance), the providers layer, the AI SDK streaming client, the
 * engine, the realtime hub and the database.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { agentMemories, getDb, messages, runSteps, usageEvents } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';

interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
}

const requests: ChatRequest[] = [];
let server: Server;
let baseUrl = '';

function chunk(body: Record<string, unknown>) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', ...body })}\n\n`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const part of request) body += part;
  return body;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void readBody(request).then((raw) => {
      const body = JSON.parse(raw) as ChatRequest;
      requests.push(body);
      if (
        body.tools?.some(
          ({ function: fn }) =>
            fn.parameters.type !== 'object' ||
            !fn.parameters.properties ||
            ['anyOf', 'oneOf', 'allOf'].some((key) => key in fn.parameters),
        )
      ) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Tool parameters must be a root object.' } }));
        return;
      }
      if (request.headers.authorization !== 'Bearer sk-loopback') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const last = body.messages[body.messages.length - 1]!;
      const asked = JSON.stringify(body.messages).includes('remember that I like tea');
      const invalid = JSON.stringify(body.messages).includes('invalid memory probe');
      if ((asked || invalid) && last.role !== 'tool') {
        response.write(
          chunk({
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_tea',
                      type: 'function',
                      function: {
                        name: 'memory',
                        arguments: JSON.stringify(
                          invalid
                            ? { action: 'remember', query: 'Tea' }
                            : { action: 'remember', title: 'Likes tea', category: 'preference' },
                        ),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
        response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      } else {
        for (const piece of ['Noted', ', ', 'Lin.']) {
          response.write(
            chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }] }),
          );
        }
        response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      }
      // A later call of the same turn starts with the prompt the vendor has seen: part of it is cached.
      const cached = requests.length > 1 ? { prompt_tokens_details: { cached_tokens: 30 } } : {};
      response.write(
        chunk({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, ...cached } }),
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  requests.length = 0;
});

describe('a real model over HTTP', () => {
  it('rejects missing action-specific fields before recording or executing a tool', async () => {
    const app = createTestApp({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: 'sk-loopback',
      LLM_MODEL: 'fake-model',
    });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'invalid memory probe' },
    });
    await app.services.engine.idle();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_tea' });
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('title');
    expect(await getDb().select().from(agentMemories).where(eq(agentMemories.memberId, lin.id))).toHaveLength(0);
    const steps = await getDb().select().from(runSteps).where(eq(runSteps.runId, sent.body.run_id));
    expect(steps.filter((step) => step.kind === 'tool')).toHaveLength(0);
  });
  it('streams a reply, runs a tool call and records usage per call', async () => {
    const app = createTestApp({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: baseUrl,
      LLM_API_KEY: 'sk-loopback',
      LLM_MODEL: 'fake-model',
    });
    const lin = await app.member();
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(lin.id, (event) => events.push(event));
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'Please remember that I like tea.' },
    });
    await app.services.engine.idle();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: 'fake-model', stream: true });
    expect(requests[0]!.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(['memory', 'ask_user']),
    );
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_tea' });
    // Roles alternate: the closing message joins the member's message instead of following it.
    const roles = requests[0]!.messages.map((message) => message.role);
    expect(roles.some((role, index) => role === 'user' && roles[index - 1] === 'user')).toBe(false);
    expect(JSON.stringify(requests[0]!.messages.at(-1))).toContain('remember that I like tea');

    const [reply] = await getDb().select().from(messages).where(eq(messages.runId, sent.body.run_id));
    expect(reply).toMatchObject({ status: 'complete', content: 'Noted, Lin.' });
    expect(reply!.steps).toEqual([expect.objectContaining({ tool: 'memory', status: 'done' })]);
    const memories = await getDb().select().from(agentMemories).where(eq(agentMemories.memberId, lin.id));
    expect(memories.map((memory) => memory.title)).toEqual(['Likes tea']);

    const usage = await getDb().select().from(usageEvents).where(eq(usageEvents.runId, sent.body.run_id));
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      capability: 'llm',
      providerId: 'env-llm',
      model: 'fake-model',
      inputTokens: 42,
      outputTokens: 7,
    });
    expect(usage.map((row) => row.cachedTokens ?? 0).sort()).toEqual([0, 30]);
    // What the vendor's cache served shows as a hit rate, for the member and for admins.
    const mine = await app.call('GET', '/api/me/usage', { token: lin.token });
    expect(mine.body.totals).toMatchObject({ input_tokens: 84, cached_tokens: 30, cache_hit_rate: 30 / 84 });
    const admin = await app.member('admin');
    const workspace = await app.call('GET', '/api/admin/usage', { token: admin.token });
    expect(workspace.body.groups.find((row: { key: string }) => row.key === lin.id)).toMatchObject({
      cache_hit_rate: 30 / 84,
    });

    const deltas = events.filter(
      (event): event is Extract<RealtimeEvent, { type: 'message.delta' }> => event.type === 'message.delta',
    );
    expect(deltas.map((event) => event.data.text).join('')).toBe('Noted, Lin.');
    // Deltas go out as frames; each frame starts where the text before it ends.
    let offset = 0;
    for (const delta of deltas) {
      expect(delta.data.offset).toBe(offset);
      offset += delta.data.text.length;
    }
  });
});
