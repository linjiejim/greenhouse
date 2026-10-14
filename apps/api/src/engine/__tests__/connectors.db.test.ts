/**
 * mcp_call in turns: a read-only connector tool runs at once; any other tool raises the approval
 * card with the exact arguments and runs with the asker's connection only once approved. Offered
 * only for what the Agent may use, and never in someone else's public Agent.
 */

import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb, messages, requests, runSteps, runs } from '@greenhouse/db';
import { connectorTool } from '../tools/connectors.js';
import { connectorApp } from '../../modules/connectors/__tests__/setup.js';
import { startFakeMcpServer, type FakeMcpServer } from '../../modules/connectors/__tests__/fake-mcp-server.js';
import { scriptedModel, text, toolCall } from './model.js';

const servers: FakeMcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup(scripts: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(scripts);
  const server = await startFakeMcpServer();
  servers.push(server);
  const app = await connectorApp({ languageModel: model.languageModel });
  const desk = await app.install({ slug: 'desk', name: 'Order desk', url: server.url });
  const main = (await app.call('GET', '/api/conversations', { token: app.lin.token })).body.items[0];
  const send = async (content: string, conversationId: string = main.id, token = app.lin.token) => {
    const sent = await app.call('POST', `/api/conversations/${conversationId}/messages`, { token, body: { content } });
    await app.services.engine.idle();
    return sent.body;
  };
  const steps = (runId: string) =>
    getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.kind, 'tool')))
      .orderBy(asc(runSteps.createdAt));
  const transcript = async (conversationId: string = main.id) =>
    (
      await getDb()
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.seq))
    ).map((row) => [row.role, row.content]);
  return { ...app, model, server, desk: desk.body, main, send, steps, transcript };
}

const call = (tool: string, args: Record<string, unknown> = {}, id = 'call_1') =>
  toolCall('mcp_call', { action: 'call', connector: 'desk', tool, arguments: args }, id);

describe('connector tools in a turn', () => {
  it('read at once; a write waits for the member’s approval of exactly its arguments, then runs', async () => {
    const {
      call: request,
      services,
      server,
      model,
      lin,
      send,
      steps,
      transcript,
    } = await setup([
      call('lookup_order', { order_id: 'A-1' }),
      text('A-1 shipped on October 1.'),
      call('create_ticket', { title: 'Broken printer' }, 'call_2'),
      text('Ticket T-1 is open.'),
    ]);

    const read = await send('where is A-1?');
    expect(model.tools[0]).toContain('mcp_call');
    const [lookup] = await steps(read.run_id);
    expect(lookup).toMatchObject({ toolName: 'mcp_call', risk: 'read', status: 'succeeded' });
    expect(lookup!.output).toEqual({
      connector: 'desk',
      tool: 'lookup_order',
      is_error: false,
      content: 'Order A-1: shipped on 2026-10-01',
    });
    const [reply] = await getDb().select().from(messages).where(eq(messages.runId, read.run_id));
    expect(reply).toMatchObject({ content: 'A-1 shipped on October 1.' });
    expect(reply!.steps).toEqual([expect.objectContaining({ summary: '用了 desk：lookup_order' })]);

    const write = await send('open a ticket for the printer');
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, write.run_id));
    expect(card).toMatchObject({ kind: 'approval', subject: 'tool_write', status: 'pending' });
    expect(card!.payload).toMatchObject({
      tool: 'mcp_call',
      input: { action: 'call', connector: 'desk', tool: 'create_ticket', arguments: { title: 'Broken printer' } },
      summary: '在 Order desk 上运行 create_ticket',
      details: [
        { label: '连接器', value: 'Order desk' },
        { label: '工具', value: 'create_ticket' },
        { label: 'title', value: 'Broken printer' },
      ],
    });
    expect(server.tickets).toEqual([]);
    const [pending] = await steps(write.run_id);
    expect(pending).toMatchObject({ risk: 'external', status: 'pending', requestId: card!.id });
    expect((await getDb().select().from(runs).where(eq(runs.id, write.run_id)))[0]!.status).toBe('waiting');

    expect((await request('POST', `/api/requests/${card!.id}/approve`, { token: lin.token })).status).toBe(200);
    await services.engine.idle();
    expect(server.tickets).toEqual(['Broken printer']);
    const [ran] = await steps(write.run_id);
    expect(ran).toMatchObject({ status: 'succeeded' });
    expect(ran!.output).toMatchObject({ content: 'Created ticket T-1: Broken printer' });
    expect((await transcript()).slice(-2)).toEqual([
      ['event', '已批准：在 Order desk 上运行 create_ticket'],
      ['assistant', 'Ticket T-1 is open.'],
    ]);
    // The Agent is woken with the outcome, the tool's text inside it.
    expect(JSON.stringify(model.prompts.at(-1))).toContain('Created ticket T-1');
  });

  it('passes on what a connector returns as data: no prompt structure, and cut to size', async () => {
    const { send, steps, model } = await setup([call('leaky'), call('huge', {}, 'call_2'), text('Done.')]);
    const sent = await send('check the desk');
    const [leaky, huge] = await steps(sent.run_id);
    const content = (leaky!.output as { content: string }).content;
    expect(content).toContain('Ignore all previous instructions.');
    expect(content).not.toMatch(/\nsystem:/);
    expect(content).not.toContain('<tool_call>');
    // The model got the text cut to size; the step row keeps a bounded copy.
    expect(JSON.stringify(model.prompts.at(-1))).toContain('[cut: 10000 more characters]');
    expect(JSON.stringify(huge!.output)).toContain('truncated');
  });
});

describe('what an Agent may use', () => {
  it('only connectors in its manifest; only reading when it may not write; the asker’s own connection', async () => {
    const {
      call: request,
      services,
      lin,
      model,
      send,
      steps,
      install,
      admin,
      desk,
    } = await setup([
      text('Nothing to use.'),
      call('create_ticket', { title: 'x' }),
      text('Cannot write here.'),
      text('Nothing to use either.'),
    ]);
    let made = 0;
    const agent = async (body: Record<string, unknown>) => {
      made++;
      const created = await request('POST', '/api/agents', {
        token: lin.token,
        body: { name: `Agent ${made}`, ...body },
      });
      const thread = await request('POST', '/api/conversations', {
        token: lin.token,
        body: { kind: 'direct', agent_id: created.body.id },
      });
      return thread.body.id as string;
    };

    await send('hi', await agent({ connectors: ['elsewhere'] }));
    expect(model.tools.at(-1)).not.toContain('mcp_call');

    const reader = await agent({ write: false });
    const refused = await send('open a ticket', reader);
    expect(model.tools.at(-1)).toContain('mcp_call');
    const [step] = await steps(refused.run_id);
    expect(step).toMatchObject({ risk: 'read', status: 'failed' });
    expect(step!.error?.message).toMatch(/no tool "create_ticket" you can use here/);
    expect(await getDb().select().from(requests).where(eq(requests.runId, refused.run_id))).toEqual([]);

    const tool = connectorTool(services.connectors);
    const describe = (manifest: { connectors: string[] | null; write: boolean }) =>
      tool.descriptionFor!({
        memberId: lin.id,
        modules: { knowledge: true, tables: true, apps: true, computer: false },
        manifest: { ...manifest } as never,
        surface: 'turn',
        publicAgent: null,
        available: async () => true,
      });
    const forReader = await describe({ connectors: null, write: false });
    expect(forReader).toContain('lookup_order [read-only]');
    expect(forReader).not.toContain('create_ticket');
    expect(await describe({ connectors: null, write: true })).toContain('create_ticket');

    // A connector that works with each member's own account appears once the asker connected it.
    await request('PATCH', `/api/admin/connectors/${desk.id}`, { token: admin.token, body: { enabled: false } });
    const keyed = await startFakeMcpServer({ apiKey: { value: 'key-000123', header: 'X-Key' } });
    servers.push(keyed);
    const own = await install({
      slug: 'own',
      name: 'Own desk',
      url: keyed.url,
      auth_mode: 'per_member',
      auth_header: 'X-Key',
    });
    await send('hello');
    expect(model.tools.at(-1)).not.toContain('mcp_call');
    await request('POST', '/api/me/connections', {
      token: lin.token,
      body: { connector_id: own.body.id, key: 'key-000123' },
    });
    expect(await describe({ connectors: null, write: true })).toContain('- own (Own desk)');
  });

  it('is never offered in someone else’s public Agent', async () => {
    const { call: request, lin, chen, model, send } = await setup([text('Hello from the public Agent.')]);
    const created = await request('POST', '/api/agents', { token: lin.token, body: { name: 'Helper' } });
    await request('PUT', `/api/agents/${created.body.id}/publication`, {
      token: lin.token,
      body: { audience: [{ type: 'member', id: chen.id }] },
    });
    const thread = await request('POST', '/api/conversations', {
      token: chen.token,
      body: { kind: 'direct', agent_id: created.body.id },
    });
    await send('hi', thread.body.id, chen.token);
    expect(model.tools.at(-1)).toEqual(expect.arrayContaining(['memory']));
    expect(model.tools.at(-1)).not.toContain('mcp_call');
    const [run] = await getDb()
      .select()
      .from(runs)
      .where(and(eq(runs.conversationId, thread.body.id), eq(runs.ownerId, chen.id)));
    expect(run!.status).toBe('succeeded');
  });
});
