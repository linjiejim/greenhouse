import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAUTH_SCOPES, type OAuthScope } from '@greenhouse/contract';
import { getDb, newId, runs } from '@greenhouse/db';
import { gate, scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';
import { ISSUER, REDIRECT, RESOURCE, callTool, connect, mcp, queryOf, toolNames } from '../../oauth/__tests__/flow.js';
import { MCP_TOOLS } from '../tools.js';

type TestApp = ReturnType<typeof createTestApp>;

/** What an MCP client keeps: its registration, its tokens and the PKCE verifier of the sign-in under way. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | null = null;
  readonly redirectUrl = REDIRECT;

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test agent',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return 'mcp-state-1';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The network of the MCP SDK, routed into the app. */
const fetchFor = (t: TestApp) =>
  ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(t.app.request(input as string, init))) as typeof fetch;

const outputOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as any;

async function personalToken(t: TestApp, member: { token: string }, scopes: readonly OAuthScope[] = OAUTH_SCOPES) {
  const created = await t.call('POST', '/api/me/tokens', { token: member.token, body: { name: 'test', scopes } });
  return created.body.token as string;
}

describe('the MCP server with a real MCP client', () => {
  it('discovers, registers, signs in through the consent page and talks to an Agent', async () => {
    const model = scriptedModel([text('Hi from Greeny.')]);
    const t = createTestApp({}, { languageModel: model.languageModel });
    const lin = await t.member();
    const url = new URL(RESOURCE);
    const provider = new MemoryProvider();
    const fetch = fetchFor(t);

    const first = new Client({ name: 'test-agent', version: '1.0.0' });
    await expect(
      first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider, fetch })),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.info?.client_id).toMatch(/^ocl_/);
    const authorization = provider.authorizationUrl!;
    expect(`${authorization.origin}${authorization.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
    expect(authorization.searchParams.get('resource')).toBe(RESOURCE);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '));

    // The browser: /oauth/authorize, then the web app's consent page, which posts the decision.
    const browser = await t.app.request(authorization.toString());
    const handle = queryOf(browser.headers.get('location')!).get('request')!;
    const page = await t.call('GET', `/api/oauth/consent?request=${handle}`, { token: lin.token });
    expect(page.body.client).toMatchObject({ name: 'Test agent', registration: 'dynamic' });
    const decision = await t.call('POST', '/api/oauth/consent', {
      token: lin.token,
      body: { request: handle, decision: 'approve' },
    });
    const back = queryOf(decision.body.redirect_to);
    expect(back.get('state')).toBe('mcp-state-1');
    await new StreamableHTTPClientTransport(url, { authProvider: provider, fetch }).finishAuth(back.get('code')!);
    expect(provider.saved).toMatchObject({ access_token: expect.stringMatching(/^gnh_at_/), token_type: 'Bearer' });

    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider, fetch }));
    expect(client.getInstructions()).toContain('Greenhouse');
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    expect(tools.find((tool) => tool.name === 'agent_message')).toMatchObject({
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', required: ['message'] },
    });

    const listed = outputOf(await client.callTool({ name: 'agents_list', arguments: {} }));
    expect(listed.agents).toEqual([expect.objectContaining({ kind: 'main', name: 'Greeny', owner: null })]);
    const asked = outputOf(await client.callTool({ name: 'agent_message', arguments: { message: 'Hello?' } }));
    expect(asked).toMatchObject({
      status: 'answered',
      agent: { name: 'Greeny' },
      replies: [{ role: 'assistant', text: 'Hi from Greeny.', status: 'complete' }],
      needs_you: [],
      url: `${ISSUER}/#/c/${asked.conversation_id}`,
    });
    // It is the member's own main thread: the app shows the exchange there.
    const main = (await t.call('GET', '/api/conversations?kind=main', { token: lin.token })).body.items[0];
    expect(main.id).toBe(asked.conversation_id);
    const transcript = await t.call('GET', `/api/conversations/${main.id}/messages`, { token: lin.token });
    expect(transcript.body.items.map((message: { content: string }) => message.content).slice(-2)).toEqual([
      'Hello?',
      'Hi from Greeny.',
    ]);
    await client.close();

    // The CLI path (OPEN-04): a personal access token as a plain bearer header.
    const cli = new Client({ name: 'greenhouse-cli', version: '1.0.0' });
    const token = await personalToken(t, lin, ['conversations:read']);
    await cli.connect(
      new StreamableHTTPClientTransport(url, { fetch, requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    expect((await cli.listTools()).tools.map((tool) => tool.name)).toEqual([
      'conversations_list',
      'conversations_search',
      'conversation_get',
    ]);
    const found = outputOf(await cli.callTool({ name: 'conversations_search', arguments: { query: 'Hello' } }));
    expect(found.results).toEqual([
      expect.objectContaining({ kind: 'message', conversation_id: main.id, text: 'Hello?' }),
    ]);
    await cli.close();
  });

  it('is stateless and open to browser clients', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const token = await personalToken(t, lin);
    const get = await t.app.request('/api/mcp', {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    expect(get.status).toBe(405);
    const preflight = await t.app.request('/api/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });
});

describe('MCP tools', () => {
  it('lists only what the token was granted', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const reader = await connect(t, lin, { approve: ['conversations:read'] });
    expect(await toolNames(t, reader.tokens.access_token)).toEqual([
      'conversations_list',
      'conversations_search',
      'conversation_get',
    ]);
    const refused = await callTool(t, reader.tokens.access_token, 'agents_list');
    expect(refused).toMatchObject({ isError: true, output: { error: { code: 'not_found' } } });

    expect(await toolNames(t, await personalToken(t, lin, ['agents:read']))).toEqual(['agents_list']);
    expect(await toolNames(t, await personalToken(t, lin, ['agents:ask']))).toEqual([
      'agents_list',
      'agent_message',
      'agent_conversation_get',
    ]);
    expect(await toolNames(t, await personalToken(t, lin, ['runs:read', 'memories:read']))).toEqual([
      'runs_list',
      'run_get',
      'schedules_list',
      'memories_list',
    ]);
    const badInput = await callTool(t, reader.tokens.access_token, 'conversation_get', { conversation_id: 7 });
    expect(badInput).toMatchObject({ isError: true, output: { error: { code: 'invalid_input' } } });
  });

  it('declares a real tool for every scope, and only scopes that exist', () => {
    for (const scope of OAUTH_SCOPES) {
      expect(
        MCP_TOOLS.some((tool) => tool.scopes.includes(scope)),
        scope,
      ).toBe(true);
    }
    for (const tool of MCP_TOOLS) expect(tool.scopes.every((scope) => OAUTH_SCOPES.includes(scope))).toBe(true);
  });

  it('waits for an Agent, reports when it is still working, and leaves writes behind the approval card', async () => {
    const hold = gate();
    const model = scriptedModel([
      { parts: text('Slow answer.'), gate: hold.promise },
      toolCall('schedule_mutation', {
        action: 'create',
        name: 'Monday plan',
        brief: 'Plan my week.',
        cron: '0 8 * * 1',
      }),
      text('Done.'),
    ]);
    const t = createTestApp({}, { languageModel: model.languageModel });
    const lin = await t.member();
    const token = await personalToken(t, lin, ['agents:ask', 'runs:read']);

    const pending = await callTool(t, token, 'agent_message', { message: 'Take your time', wait_seconds: 0 });
    expect(pending.output.status).toBe('working');
    // A reply may already be under way: it shows as streaming, never as done.
    expect(pending.output.replies.every((reply: { status: string }) => reply.status === 'streaming')).toBe(true);
    const conversationId = pending.output.conversation_id;
    expect(
      (await callTool(t, token, 'agent_conversation_get', { conversation_id: conversationId })).output.status,
    ).toBe('working');
    hold.open();
    const done = await callTool(t, token, 'agent_conversation_get', {
      conversation_id: conversationId,
      wait_seconds: 5,
    });
    expect(done.output).toMatchObject({
      status: 'answered',
      replies: [{ role: 'assistant', text: 'Slow answer.' }],
    });

    const write = await callTool(t, token, 'agent_message', { message: 'Plan every Monday', wait_seconds: 5 });
    expect(write.output).toMatchObject({
      status: 'needs_you',
      needs_you: [{ kind: 'approval', title: expect.stringContaining('Monday plan') }],
      url: `${ISSUER}/#/c/${conversationId}`,
    });
    // Nothing happened yet: the member decides in the app.
    expect((await callTool(t, token, 'schedules_list')).output.schedules).toEqual([]);
    await t.services.engine.idle();
  });

  it('acts with exactly the rights of its member', async () => {
    const model = scriptedModel([text('Chen, noted.')]);
    const t = createTestApp({}, { languageModel: model.languageModel });
    const lin = await t.member();
    const chen = await t.member();
    const chenMain = (await t.call('GET', '/api/conversations', { token: chen.token })).body.items[0];
    await t.call('POST', `/api/conversations/${chenMain.id}/messages`, {
      token: chen.token,
      body: { content: 'my secret plan' },
    });
    await t.services.engine.idle();
    const helper = await t.call('POST', '/api/agents', {
      token: chen.token,
      body: { name: 'Helper', role: 'Research' },
    });
    await t.call('POST', '/api/agents/main/memories', { token: chen.token, body: { title: 'Chen likes tea' } });
    const chenRun = newId('run');
    await getDb().insert(runs).values({
      id: chenRun,
      agentId: helper.body.id,
      ownerId: chen.id,
      kind: 'background',
      source: 'conversation',
      status: 'succeeded',
      title: 'Chen research',
      brief: 'Private brief',
    });
    const token = await personalToken(t, lin);
    const refusal = async (name: string, args: Record<string, unknown>) => {
      const result = await callTool(t, token, name, args);
      expect(result.isError, name).toBe(true);
      return result.output.error.code as string;
    };

    expect(await refusal('conversation_get', { conversation_id: chenMain.id })).toBe('not_found');
    expect(await refusal('agent_conversation_get', { conversation_id: chenMain.id })).toBe('not_found');
    expect(await refusal('agent_message', { agent_id: helper.body.id, message: 'hi', wait_seconds: 0 })).toBe(
      'not_found',
    );
    expect(await refusal('run_get', { run_id: chenRun })).toBe('not_found');
    expect(await refusal('memories_list', { agent_id: helper.body.id })).toBe('not_found');
    expect((await callTool(t, token, 'runs_list')).output.runs).toEqual([]);
    expect((await callTool(t, token, 'conversations_search', { query: 'secret' })).output.results).toEqual([]);
    expect(
      (await callTool(t, token, 'agents_list')).output.agents.map((agent: { kind: string }) => agent.kind),
    ).toEqual(['main']);

    // Once Chen publishes Helper to everyone, Lin can find it and talk to it, as Lin.
    await t.call('PUT', `/api/agents/${helper.body.id}/publication`, {
      token: chen.token,
      body: { audience: [{ type: 'workspace' }] },
    });
    const shared = (await callTool(t, token, 'agents_list')).output.agents;
    expect(shared[1]).toMatchObject({ id: helper.body.id, kind: 'public', owner: chen.name, name: 'Helper' });
    const asked = await callTool(t, token, 'agent_message', { agent_id: helper.body.id, message: 'Hello Helper' });
    expect(asked.output).toMatchObject({ status: 'answered', agent: { id: helper.body.id, name: 'Helper' } });
    // The exchange lives in Lin's own thread with Helper; its owner cannot read it.
    const thread = await t.call('GET', `/api/conversations/${asked.output.conversation_id}`, { token: lin.token });
    expect(thread.body).toMatchObject({ kind: 'direct', agent_id: helper.body.id });
    expect(
      (await t.call('GET', `/api/conversations/${asked.output.conversation_id}`, { token: chen.token })).status,
    ).toBe(404);
    // An admin's pause reaches outside callers too.
    const admin = await t.member('admin');
    await t.call('POST', `/api/admin/public-agents/${helper.body.id}/pause`, { token: admin.token });
    expect(await refusal('agent_message', { agent_id: helper.body.id, message: 'still there?' })).toBe('agent_paused');
  });

  it("reads the member's conversations, runs, schedules and memories", async () => {
    const model = scriptedModel([text('Bananas are berries.')]);
    const t = createTestApp({}, { languageModel: model.languageModel });
    const lin = await t.member();
    const chen = await t.member();
    const main = (await t.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    await t.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'Tell me about bananas' },
    });
    await t.services.engine.idle();
    const room = await t.call('POST', '/api/conversations', {
      token: lin.token,
      body: { kind: 'room', title: 'Fruit council', member_ids: [chen.id] },
    });
    await t.call('POST', '/api/schedules', {
      token: lin.token,
      body: { agent_id: 'main', name: 'Morning fruit', brief: 'List fruit.', cron: '0 9 * * *' },
    });
    await t.call('POST', '/api/agents/main/memories', {
      token: lin.token,
      body: { title: 'Lin likes bananas', content: 'Especially ripe ones.', pinned: true },
    });
    const mainAgent = (await t.call('GET', '/api/agents/main', { token: lin.token })).body;
    const runId = newId('run');
    await getDb()
      .insert(runs)
      .values({
        id: runId,
        agentId: mainAgent.id,
        ownerId: lin.id,
        kind: 'background',
        source: 'conversation',
        status: 'succeeded',
        title: 'Fruit report',
        brief: 'Count the fruit.',
        output: { text: 'Three bananas.' },
      });
    const token = await personalToken(t, lin);

    const conversations = (await callTool(t, token, 'conversations_list')).output;
    expect(conversations.conversations).toEqual([
      expect.objectContaining({ id: room.body.id, kind: 'room', title: 'Fruit council' }),
      expect.objectContaining({ id: main.id, kind: 'main', title: 'Greeny' }),
    ]);
    expect((await callTool(t, token, 'conversations_list', { kind: 'room' })).output.conversations).toHaveLength(1);
    const found = (await callTool(t, token, 'conversations_search', { query: 'bananas' })).output.results;
    expect(found).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'message', conversation_id: main.id, seq: 2 })]),
    );
    const read = (await callTool(t, token, 'conversation_get', { conversation_id: main.id })).output;
    expect(read.conversation).toMatchObject({ id: main.id, kind: 'main', title: 'Greeny' });
    expect(read.messages.slice(-2)).toEqual([
      expect.objectContaining({ seq: 2, role: 'user', author: lin.name, text: 'Tell me about bananas' }),
      expect.objectContaining({ seq: 3, role: 'assistant', author: 'Greeny', text: 'Bananas are berries.' }),
    ]);
    const later = (await callTool(t, token, 'conversation_get', { conversation_id: main.id, after_seq: 2 })).output;
    expect(later.messages.map((message: { seq: number }) => message.seq)).toEqual([3]);

    expect((await callTool(t, token, 'runs_list', { agent_id: 'main' })).output.runs).toEqual([
      expect.objectContaining({ id: runId, title: 'Fruit report', status: 'succeeded' }),
    ]);
    expect((await callTool(t, token, 'run_get', { run_id: runId })).output).toMatchObject({
      id: runId,
      brief: 'Count the fruit.',
      output: 'Three bananas.',
      steps: [],
    });
    expect((await callTool(t, token, 'schedules_list')).output.schedules).toEqual([
      expect.objectContaining({ name: 'Morning fruit', cron: '0 9 * * *', status: 'active' }),
    ]);
    expect((await callTool(t, token, 'memories_list')).output.memories).toEqual([
      expect.objectContaining({ title: 'Lin likes bananas', content: 'Especially ripe ones.', pinned: true }),
    ]);
    // Reading works without the scope only when it is granted.
    const narrow = await personalToken(t, lin, ['agents:read']);
    expect((await mcp(t, narrow, 'tools/call', { name: 'memories_list', arguments: {} })).body.result.isError).toBe(
      true,
    );
  });
});
