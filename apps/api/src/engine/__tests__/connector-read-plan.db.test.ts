/**
 * Approved-task regressions use the production API/loop and real local MCP protocol, with a
 * scripted model and synthetic accounts. The remaining cases drive production tool assembly
 * directly to exercise exact security and recovery boundaries; they are not real-model E2E.
 */
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { connections, connectors, getDb, members, newId, requests, runs, runSteps } from '@greenhouse/db';
import { connectorApp } from '../../modules/connectors/__tests__/setup.js';
import { startFakeMcpServer, type FakeMcpServer } from '../../modules/connectors/__tests__/fake-mcp-server.js';
import { ConnectorOAuthProvider } from '../../modules/connectors/oauth.js';
import { findConnection } from '../../modules/connectors/store.js';
import { assembleTools } from '../tools/assemble.js';
import { connectorTool, describeConnectors } from '../tools/connectors.js';
import { MAX_READ_AHEAD, MAX_READ_AHEAD_BYTES } from '../tools/connector-reads.js';
import { defineTool, type ToolContext } from '../tools/define.js';
import { scriptedModel, text, toolCall } from './model.js';

const KEY = 'synthetic-read-plan-key';
const servers: FakeMcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const read = (orderId: string, extra: Record<string, unknown> = {}) => ({
  action: 'call' as const,
  connector: 'desk',
  tool: 'lookup_order',
  arguments: { order_id: orderId },
  ...extra,
});
const plan = () => read('A-1', { read_ahead: [{ tool: 'lookup_order', arguments: { order_id: 'A-2' } }] });
const report = 'A-1 and A-2 both shipped on 2026-10-01.';
const brief = 'Read A-1 and A-2 from my order desk and compare shipping status. Do not write or send anything.';

async function setup(
  options: {
    auth?: 'none' | 'shared' | 'per_member' | 'oauth';
    trusted?: string[];
    scripts?: Parameters<typeof scriptedModel>[0];
  } = {},
) {
  const auth = options.auth ?? 'per_member';
  const model = scriptedModel(options.scripts ?? [text('Scripted response.')]);
  const server = await startFakeMcpServer(
    auth === 'none'
      ? {}
      : auth === 'shared'
        ? { token: KEY }
        : auth === 'oauth'
          ? { oauth: {} }
          : { apiKey: { value: KEY, header: 'X-Key' } },
  );
  servers.push(server);
  const app = await connectorApp({ languageModel: model.languageModel });
  const installed = await app.install({
    slug: 'desk',
    name: 'Order desk',
    url: server.url,
    auth_mode: auth,
    ...(auth === 'shared' ? { shared_key: KEY, auth_prefix: 'Bearer ' } : {}),
    ...(auth === 'per_member' ? { auth_header: 'X-Key' } : {}),
  });
  expect(installed.status).toBe(201);
  const connectorId = installed.body.id as string;
  const signIn = async (subject = 'alice') => {
    server.oauth!.nextSubject = subject;
    const started = await app.call('POST', '/api/me/connections/oauth/start', {
      token: app.lin.token,
      body: { connector_id: connectorId },
    });
    expect(started.status).toBe(200);
    const consent = await fetch(started.body.authorization_url, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    const back = await app.app.request(consent.headers.get('location')!.replace('http://greenhouse.test', ''));
    expect(back.status).toBe(302);
    const query = new URLSearchParams(back.headers.get('location')!.split('?')[1]);
    const finished = await app.call('POST', '/api/me/connections/oauth/finish', {
      token: app.lin.token,
      body: { state: query.get('oauth_state'), code: query.get('oauth_code') },
    });
    expect(finished.status).toBe(200);
    return finished.body.id as string;
  };
  let connectionId: string | null = null;
  if (auth === 'per_member') {
    const connected = await app.call('POST', '/api/me/connections', {
      token: app.lin.token,
      body: { connector_id: connectorId, key: KEY },
    });
    expect(connected.status).toBe(201);
    connectionId = connected.body.id as string;
  } else if (auth === 'oauth') connectionId = await signIn();
  // Exercise the real admin entrypoint, not a fixture-only database read-only flag.
  expect(
    (
      await app.call('PATCH', `/api/admin/connectors/${connectorId}`, {
        token: app.admin.token,
        body: { read_only_tools: options.trusted ?? ['lookup_order'] },
      })
    ).status,
  ).toBe(200);
  const main = (await app.call('GET', '/api/conversations', { token: app.lin.token })).body.items[0];
  const { agent, manifest } = await app.services.agents.load(app.lin.id, main.agent_id);
  const publicSource = defineTool({
    name: 'public_source',
    description: 'Read a synthetic public source.',
    input: z.object({}),
    risk: 'read',
    taints: true,
    outbound: true,
    idempotent: true,
    execute: async () => ({ text: 'Untrusted public source data.' }),
  });
  async function direct(
    options: {
      runId?: string;
      attempt?: number;
      memberId?: string;
      tainted?: boolean;
      eventWoken?: boolean;
    } = {},
  ) {
    const runId = options.runId ?? newId('run');
    const attempt = options.attempt ?? 1;
    if (!options.runId)
      await getDb()
        .insert(runs)
        .values({
          id: runId,
          agentId: agent.id,
          ownerId: app.lin.id,
          requestedBy: app.lin.id,
          kind: 'background',
          source: 'conversation',
          conversationId: main.id,
          title: 'Read-plan boundary',
          brief,
          status: 'running',
          attempt,
          ...(options.tainted ? { checkpoint: { tainted: true } } : {}),
        });
    let tainted = options.tainted ?? false;
    const context: Omit<ToolContext, 'stepId' | 'raise' | 'endTurn'> = {
      memberId: options.memberId ?? app.lin.id,
      agent,
      manifest,
      conversation: null,
      runId,
      attempt,
      locale: 'en',
      surface: 'background',
      eventWoken: options.eventWoken,
      signal: new AbortController().signal,
      taint: () => {
        tainted = true;
      },
      tainted: () => tainted,
    };
    const assembled = await assembleTools({
      defs: [connectorTool(app.services.connectors), publicSource],
      context,
      availability: {
        memberId: context.memberId,
        modules: { knowledge: true, tables: true, apps: true, computer: true },
        manifest,
        surface: 'background',
        runKind: 'background',
        publicAgent: null,
        available: async () => true,
      },
      raise: async () => {
        throw new Error('Unexpected approval');
      },
      approvalTitle: (summary) => summary,
    });
    let callIndex = 0;
    const call = async (args: unknown, id = `call_${++callIndex}`, name = 'mcp_call') => {
      const parsed = assembled.defs.get(name)!.input.parse(args);
      return assembled.tools[name]!.execute!(parsed, { toolCallId: id, messages: [], context: undefined });
    };
    return { runId, call, assembled };
  }
  const steps = (runId: string) =>
    getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.kind, 'tool')))
      .orderBy(asc(runSteps.createdAt), asc(runSteps.key));
  const currentRun = async (runId: string) => (await getDb().select().from(runs).where(eq(runs.id, runId)))[0]!;
  const approved = async () => {
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: app.lin.token,
      body: { content: `Run in the background: ${brief}` },
    });
    expect(sent.status).toBe(201);
    await app.services.engine.idle();
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, sent.body.run_id));
    expect(card).toMatchObject({ subject: 'run_start', status: 'pending' });
    expect(server.calls).toEqual([]);
    expect((await app.call('POST', `/api/requests/${card!.id}/approve`, { token: app.lin.token })).status).toBe(200);
    await app.services.engine.idle();
    const listed = (await app.call('GET', '/api/runs', { token: app.lin.token })).body.items;
    expect(listed).toHaveLength(1);
    return listed[0].id as string;
  };
  return {
    ...app,
    model,
    server,
    connectorId,
    connectionId,
    signIn,
    main,
    agent,
    manifest,
    direct,
    steps,
    currentRun,
    approved,
  };
}

describe('approved connector task through the production loop', () => {
  it.each(['per_member', 'shared'] as const)(
    'completes both prepared order reads using %s authentication',
    async (auth) => {
      const s = await setup({
        auth,
        scripts: [
          toolCall('run_start', { title: 'Compare two orders', brief }),
          text('Proposed the task.'),
          toolCall('mcp_call', { action: 'list' }),
          toolCall('mcp_call', { action: 'describe', connector: 'desk', tool: 'lookup_order' }),
          toolCall('mcp_call', plan()),
          toolCall('mcp_call', read('A-2')),
          toolCall('run_finish', { report, findings: [report] }),
          text('The task report is ready.'),
        ],
      });
      const runId = await s.approved();
      const run = await s.currentRun(runId);
      expect(run).toMatchObject({
        status: 'succeeded',
        errorCode: null,
        errorMessage: null,
        output: { text: report, findings: [report] },
      });
      expect(s.server.calls.map((call) => [call.tool, call.arguments])).toEqual([
        ['lookup_order', { order_id: 'A-1' }],
        ['lookup_order', { order_id: 'A-2' }],
      ]);
      expect(new Set(s.server.calls.map((call) => call.identity)).size).toBe(1);
      expect(s.server.tickets).toEqual([]);
      const successful = (await s.steps(runId)).filter((step) => step.toolName === 'mcp_call');
      expect(successful).toHaveLength(4);
      expect(successful.every((step) => step.status === 'succeeded')).toBe(true);
      expect(successful.map((step) => JSON.stringify(step.output)).join('\n')).toContain('Order A-2: shipped');
      expect(JSON.stringify(s.model.prompts)).toContain('Order A-1: shipped');
      expect(JSON.stringify(s.model.prompts)).toContain('Order A-2: shipped');
      expect(run.checkpoint).toMatchObject({ read_private: true, tainted: true, connector_reads: { version: 1 } });
      expect(JSON.stringify(run.checkpoint?.connector_reads)).not.toContain('A-1');
      expect(JSON.stringify(run.checkpoint?.connector_reads)).not.toContain(KEY);
      const detail = await s.call('GET', `/api/runs/${runId}`, { token: s.lin.token });
      expect(detail.status).toBe(200);
      expect(detail.body.steps.filter((step: { status: string }) => step.status === 'failed')).toEqual([]);
    },
  );

  it('keeps the original undeclared A-2 control blocked and exposes its actionable failed step', async () => {
    const s = await setup({
      scripts: [
        toolCall('run_start', { title: 'Unprepared control', brief }),
        text('Proposed the task.'),
        toolCall('mcp_call', read('A-1')),
        toolCall('mcp_call', read('A-2')),
        // This ending is deliberately scripted. It is not evidence of real-model completion claims.
        text('Scripted closing text after the refusal.'),
      ],
    });
    const runId = await s.approved();
    expect((await s.currentRun(runId)).status).toBe('succeeded');
    expect(s.server.calls.map((call) => call.arguments)).toEqual([{ order_id: 'A-1' }]);
    const detail = await s.call('GET', `/api/runs/${runId}`, { token: s.lin.token });
    const failed = detail.body.steps.filter((step: { status: string }) => step.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ tool: 'mcp_call', error: { code: 'connector_read_plan_required' } });
    expect(failed[0].error.message).toContain('读取参数未提前声明');
    expect(failed[0].error.message).toContain('新任务');
    expect(failed[0].error.message).not.toContain('网页');
    expect(failed[0].summary).toContain('连接器');
    expect(s.server.tickets).toEqual([]);
  });
});

describe('connector read plan boundaries and recovery', () => {
  it('refreshes local metadata after a private read and reuses the exact saved result without another MCP request', async () => {
    const s = await setup();
    const r = await s.direct();
    const first = await r.call(read('A-1'));
    const before = s.server.requests.length;
    expect(await r.call(read('A-1'))).toEqual(first);
    const listed = (await r.call({ action: 'list' })) as {
      connectors: Array<{ tools: Array<{ name: string; read_ahead_allowed: boolean }> }>;
    };
    expect(listed.connectors[0]!.tools.find((tool) => tool.name === 'lookup_order')!.read_ahead_allowed).toBe(true);
    expect(await r.call({ action: 'describe', connector: 'desk', tool: 'lookup_order' })).toMatchObject({
      read_ahead_allowed: true,
    });
    expect(s.server.requests).toHaveLength(before);
    expect(s.server.calls).toHaveLength(1);
    expect(describeConnectors(await s.services.connectors.usable(s.lin.id, s.manifest))).toContain(
      'lookup_order [read-only] [read-ahead]',
    );
    await s.call('DELETE', `/api/me/connections/${s.connectionId}`, { token: s.lin.token });
    expect(await r.call({ action: 'list' })).toEqual({ connectors: [] });
    await expect(r.call({ action: 'describe', connector: 'desk', tool: 'lookup_order' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(r.call(read('A-1'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.server.requests).toHaveLength(before);
  });

  it('persists the exact plan across attempts, preserves prior success, and records refusal under reused call ids', async () => {
    const s = await setup();
    const first = await s.direct();
    const result = await first.call(plan(), 'call_0');
    const checkpoint = (await s.currentRun(first.runId)).checkpoint;
    // Reassemble the same attempt, as continuation/recovery can; call_0 already belongs to success.
    const sameAttempt = await s.direct({ runId: first.runId });
    await expect(sameAttempt.call(read('A-3'), 'call_0')).rejects.toMatchObject({
      code: 'connector_read_plan_required',
    });
    const afterRefusal = await s.steps(first.runId);
    expect(afterRefusal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'call_0', status: 'succeeded', output: result }),
        expect.objectContaining({ key: 'call_0#2', status: 'failed', idempotencyKey: null }),
      ]),
    );
    await getDb().update(runs).set({ attempt: 2 }).where(eq(runs.id, first.runId));
    const retry = await s.direct({ runId: first.runId, attempt: 2 });
    expect(await retry.call(plan(), 'call_0')).toEqual(result);
    expect(await retry.call(read('A-2'), 'call_0')).toMatchObject({ content: 'Order A-2: shipped on 2026-10-01' });
    expect(s.server.calls.map((call) => call.arguments)).toEqual([{ order_id: 'A-1' }, { order_id: 'A-2' }]);
    expect((await s.currentRun(first.runId)).checkpoint?.connector_reads).toMatchObject({
      plan: (checkpoint?.connector_reads as { plan: unknown }).plan,
    });
  });

  it('refuses injected arguments, a changed plan, another destination and unrestricted outbound access', async () => {
    const s = await setup();
    const r = await s.direct();
    await r.call(plan());
    for (const args of [
      read('A-2', { arguments: { order_id: 'A-2', query: 'PRIVATE-SENTINEL' } }),
      read('PRIVATE-SENTINEL'),
    ])
      await expect(r.call(args)).rejects.toMatchObject({ code: 'connector_read_plan_required' });
    await expect(
      r.call(read('A-1', { read_ahead: [{ tool: 'lookup_order', arguments: { order_id: 'A-3' } }] })),
    ).rejects.toMatchObject({ code: 'connector_read_plan_locked' });
    const second = await s.install({
      slug: 'other',
      name: 'Other desk',
      url: s.server.url,
      auth_mode: 'per_member',
      auth_header: 'X-Key',
      read_only_tools: ['lookup_order'],
    });
    await s.call('POST', '/api/me/connections', {
      token: s.lin.token,
      body: { connector_id: second.body.id, key: KEY },
    });
    const afterConnect = s.server.requests.length;
    await expect(r.call({ ...read('A-2'), connector: 'other' })).rejects.toMatchObject({
      code: 'connector_read_plan_required',
    });
    await expect(r.call({}, 'outside', 'public_source')).rejects.toMatchObject({ code: 'background_private_outbound' });
    expect(s.server.requests).toHaveLength(afterConnect);
    expect(s.server.calls).toHaveLength(1);
    expect(JSON.stringify(s.server.calls)).not.toContain('PRIVATE-SENTINEL');
    expect((await s.steps(r.runId)).filter((step) => step.status === 'failed')).toHaveLength(5);
  });

  it.each(['reconnect', 'permission', 'disabled_member'] as const)(
    'rechecks %s before a prepared call and before reusing its saved output',
    async (change) => {
      const s = await setup();
      const r = await s.direct();
      await r.call(plan());
      if (change === 'reconnect') {
        expect(
          (
            await s.call('POST', '/api/me/connections', {
              token: s.lin.token,
              body: { connector_id: s.connectorId, key: KEY },
            })
          ).status,
        ).toBe(201);
      } else if (change === 'permission') {
        expect(
          (
            await s.call('PATCH', `/api/admin/connectors/${s.connectorId}`, {
              token: s.admin.token,
              body: { read_only_tools: [] },
            })
          ).status,
        ).toBe(200);
      } else await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, s.lin.id));
      const before = s.server.requests.length;
      const code = change === 'disabled_member' ? 'member_inactive' : 'connector_read_scope_changed';
      await expect(r.call(read('A-1'))).rejects.toMatchObject({ code });
      await expect(r.call(read('A-2'))).rejects.toMatchObject({ code });
      expect(s.server.requests).toHaveLength(before);
      expect(s.server.calls).toHaveLength(1);
    },
  );

  it('does not transfer an approved run or its cached result to another member', async () => {
    const s = await setup({ auth: 'shared' });
    const r = await s.direct();
    await r.call(plan());
    const other = await s.direct({ runId: r.runId, memberId: s.chen.id });
    const before = s.server.requests.length;
    await expect(other.call(read('A-1'))).rejects.toMatchObject({ code: 'connector_read_scope_changed' });
    await expect(other.call(read('A-2'))).rejects.toMatchObject({ code: 'connector_read_scope_changed' });
    expect(s.server.requests).toHaveLength(before);
  });

  it('refuses a connection change after freezing the plan but before its very first private read', async () => {
    const s = await setup();
    const r = await s.direct();
    const original = s.services.connectors.readAccess.bind(s.services.connectors);
    let reconnected = false;
    const access = vi.spyOn(s.services.connectors, 'readAccess').mockImplementation(async (...args) => {
      const checkpoint = (await s.currentRun(r.runId)).checkpoint?.connector_reads as { plan?: unknown } | undefined;
      if (!reconnected && checkpoint?.plan) {
        reconnected = true;
        expect(
          (
            await s.call('POST', '/api/me/connections', {
              token: s.lin.token,
              body: { connector_id: s.connectorId, key: KEY },
            })
          ).status,
        ).toBe(201);
      }
      return original(...args);
    });
    try {
      await expect(r.call(plan())).rejects.toMatchObject({ code: 'connector_read_scope_changed' });
      expect(reconnected).toBe(true);
      expect(s.server.calls).toEqual([]);
      expect(await s.steps(r.runId)).toEqual([
        expect.objectContaining({
          status: 'failed',
          error: { code: 'connector_read_scope_changed', message: expect.any(String) },
        }),
      ]);
    } finally {
      access.mockRestore();
    }
  });

  it('requires an admin read-only decision for every plan entry, and refuses writes and destructive actions', async () => {
    const s = await setup({ trusted: [] });
    const r = await s.direct();
    const description = await r.call({ action: 'describe', connector: 'desk', tool: 'lookup_order' });
    expect(description).toMatchObject({ read_only: true, read_ahead_allowed: false });
    await expect(r.call(plan())).rejects.toMatchObject({ code: 'connector_read_only_unverified' });
    expect(s.server.calls).toEqual([]);
    const fresh = await s.direct();
    await expect(
      fresh.call({ action: 'call', connector: 'desk', tool: 'create_ticket', arguments: { title: 'No write' } }),
    ).rejects.toMatchObject({ code: 'connector_background_read_only' });
    await s.call('PATCH', `/api/admin/connectors/${s.connectorId}`, {
      token: s.admin.token,
      body: { read_only_tools: ['lookup_order', 'drop_table'] },
    });
    const dangerous = await s.direct();
    await expect(
      dangerous.call(read('A-1', { read_ahead: [{ tool: 'drop_table', arguments: { name: 'No drop' } }] })),
    ).rejects.toMatchObject({ code: 'connector_read_only_unverified' });
    expect(s.server.calls).toEqual([]);
    expect(s.server.tickets).toEqual([]);
  });

  it.each(['initial_taint', 'public_then_metadata', 'metadata_then_public', 'event'] as const)(
    'cannot register a new plan from %s',
    async (source) => {
      const s = await setup();
      const r = await s.direct({ tainted: source === 'initial_taint', eventWoken: source === 'event' });
      if (source === 'metadata_then_public') await r.call({ action: 'list' });
      if (source === 'public_then_metadata' || source === 'metadata_then_public')
        await r.call({}, 'public', 'public_source');
      if (source === 'initial_taint' || source === 'public_then_metadata') await r.call({ action: 'list' });
      await expect(r.call(plan())).rejects.toMatchObject({ code: 'connector_read_plan_locked' });
      expect(s.server.calls).toEqual([]);
      expect((await s.currentRun(r.runId)).checkpoint?.read_private).not.toBe(true);
    },
  );

  it('bounds exact plan size before any remote read and permits the finite count boundary', async () => {
    const s = await setup();
    const r = await s.direct();
    const future = Array.from({ length: MAX_READ_AHEAD }, (_, i) => ({
      tool: 'lookup_order',
      arguments: { order_id: `A-${i + 2}` },
    }));
    expect(
      r.assembled.defs.get('mcp_call')!.input.safeParse(read('A-1', { read_ahead: [...future, future[0]] })).success,
    ).toBe(false);
    await expect(
      r.call(
        read('A-1', {
          read_ahead: [{ tool: 'lookup_order', arguments: { order_id: 'x'.repeat(MAX_READ_AHEAD_BYTES) } }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'connector_read_plan_limit' });
    expect(s.server.calls).toEqual([]);
    const allowed = await s.direct();
    await allowed.call(read('A-1', { read_ahead: future }));
    expect(await allowed.call(read('A-17'))).toMatchObject({ content: 'Order A-17: shipped on 2026-10-01' });
    expect(s.server.calls).toHaveLength(2);
  });
});

describe('prepared OAuth reads', () => {
  it('allows the checked call to refresh its own token, then invalidates the remaining plan and cache', async () => {
    const s = await setup({ auth: 'oauth' });
    const r = await s.direct();
    s.server.oauth!.expireAccessTokens();
    expect(await r.call(plan())).toMatchObject({ content: 'Order A-1: shipped on 2026-10-01' });
    expect(s.server.oauth!.refreshCount).toBe(1);
    const before = s.server.requests.length;
    for (const id of ['A-1', 'A-2'])
      await expect(r.call(read(id))).rejects.toMatchObject({ code: 'connector_read_scope_changed' });
    expect(s.server.requests).toHaveLength(before);
    expect(s.server.calls).toHaveLength(1);
  });

  it('pins late OAuth token lookup to the checked sign-in and rejects switching accounts', async () => {
    const s = await setup({ auth: 'oauth', trusted: ['lookup_order', 'whoami'] });
    const [connector] = await getDb().select().from(connectors).where(eq(connectors.id, s.connectorId));
    const connection = (await findConnection(s.lin.id, s.connectorId))!;
    const provider = new ConnectorOAuthProvider(
      {
        key: Buffer.from('b'.repeat(64), 'hex'),
        mode: 'development',
        redirectUri: 'http://greenhouse.test/api/connectors/oauth/callback',
      },
      connector!,
      s.lin.id,
      'call',
    );
    provider.pinConnection(connection.id, connection.secretsEnc!);
    await s.signIn('alice2');
    await expect(provider.tokens()).rejects.toMatchObject({ code: 'connector_read_scope_changed' });
    const current = await s.services.connectors.readAccess(s.lin.id, s.manifest, 'desk', 'whoami');
    const before = s.server.requests.length;
    await getDb().update(connections).set({ status: 'needs_reauth' }).where(eq(connections.id, s.connectionId!));
    await expect(
      s.services.connectors.run(s.lin.id, s.connectorId, 'whoami', {}, undefined, {
        manifest: s.manifest,
        binding: current.binding,
        trustedReadOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'connector_connection_unavailable' });
    expect(s.server.requests).toHaveLength(before);
    expect(s.server.calls).toEqual([]);
  });
});
