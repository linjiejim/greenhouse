import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { connectors, files, getDb, newId, requests, runs, runSteps } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import type { ConnectorsService } from '../../modules/connectors/service.js';
import { connectorTool } from '../tools/connectors.js';
import type { ToolDef } from '../tools/define.js';
import { z } from 'zod';
import { defineTool } from '../tools/define.js';
import { assembleTools } from '../tools/assemble.js';
import { scriptedModel, text, toolCall } from './model.js';
import { storeToolOutput } from '../tools/output.js';

async function setup(options: { tools?: ToolDef[]; model?: ReturnType<typeof scriptedModel> } = {}) {
  const fetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('tavily')
      ? Response.json({
          results: Array.from({ length: 10 }, (_, i) => ({
            url: `https://example.com/${i}`,
            title: 'Public pricing '.repeat(20),
            content: 'public '.repeat(200),
          })),
        })
      : new Response('Public pricing. '.repeat(1500), { headers: { 'content-type': 'text/plain' } }),
  );
  const app = createTestApp(
    {
      SEARCH_PROVIDER: 'tavily',
      TAVILY_API_KEY: 'tvly-test',
      STORAGE_PROVIDER: 'local',
      STORAGE_ROOT: `${process.cwd()}/node_modules/.cache/t15-output-tests`,
    },
    {
      fetch: fetch as typeof globalThis.fetch,
      tools: options.tools,
      ...(options.model ? { languageModel: options.model.languageModel } : {}),
    },
  );
  const member = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  const { agent, manifest } = await app.services.agents.load(member.id, main.agent_id);
  const seal = vi.fn(async () => {});
  async function run(extra: ToolDef[] = []) {
    const runId = newId('run');
    await getDb().insert(runs).values({
      id: runId,
      agentId: agent.id,
      ownerId: member.id,
      requestedBy: member.id,
      kind: 'background',
      source: 'conversation',
      title: 'Provenance',
      brief: 'Read sources',
      status: 'running',
    });
    let tainted = false;
    const tools = await assembleTools({
      defs: [...app.services.engine.toolsForEvaluation(), ...extra],
      context: {
        memberId: member.id,
        agent,
        manifest,
        conversation: null,
        runId,
        locale: 'en',
        surface: 'background',
        signal: new AbortController().signal,
        taint: () => {
          tainted = true;
        },
        tainted: () => tainted,
      },
      availability: {
        memberId: member.id,
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
      approvalTitle: (s) => s,
      output: (value, ctx) => storeToolOutput(app.services.files, value, ctx),
      privateRead: seal,
    });
    let index = 0;
    return {
      runId,
      tools,
      call: async (name: string, args: unknown) => {
        const parsed = tools.defs.get(name)!.input.parse(args);
        return tools.tools[name]!.execute!(parsed, { toolCallId: `call_${++index}`, messages: [], context: undefined });
      },
    };
  }
  return { ...app, member, newMember: app.member, main, run, fetch, seal };
}

type Stored = { file: { id: string } };

describe('background source provenance', () => {
  it('keeps web and search outputs public when read back, including in a fresh run', async () => {
    const s = await setup();
    const r = await s.run();
    const output = (await r.call('web_fetch', { url: 'https://example.com/pricing' })) as Stored;
    expect((await s.services.files.get(s.member.id, output.file.id)).meta).toMatchObject({
      tool_output: { private: false },
    });
    await r.call('tool_output_read', { file_id: output.file.id });
    await expect(r.call('web_fetch', { url: 'https://example.com/details' })).resolves.toBeTruthy();
    const search = (await r.call('web_search', { query: 'public pricing', limit: 10 })) as Stored;
    await r.call('tool_output_read', { file_id: search.file.id });
    const fresh = await s.run();
    await fresh.call('tool_output_read', { file_id: output.file.id });
    await expect(fresh.call('web_fetch', { url: 'https://example.com/follow-up' })).resolves.toBeTruthy();
    expect(s.seal).not.toHaveBeenCalled();
    expect((await getDb().select().from(runs).where(eq(runs.id, fresh.runId)))[0]!.checkpoint).toMatchObject({
      read_private: false,
      tainted: true,
    });
  });

  it('keeps files produced by the run public until the run reads private data', async () => {
    const s = await setup();
    const r = await s.run([
      defineTool({
        name: 'generated',
        description: 'Generate a table of numbers',
        input: z.object({}),
        risk: 'read',
        execute: async () => '1234567890'.repeat(1000),
      }),
    ]);
    const output = (await r.call('generated', {})) as Stored;
    await r.call('tool_output_read', { file_id: output.file.id });
    await expect(r.call('web_fetch', { url: 'https://example.com/follow-up' })).resolves.toBeTruthy();
    expect(s.seal).not.toHaveBeenCalled();
  });

  it('preserves public generated output through the separate approved execution path', async () => {
    const execute = vi.fn(async () => 'Generated public output. '.repeat(500));
    const s = await setup({
      tools: [
        defineTool({
          name: 'generated_write',
          description: 'Write generated output',
          input: z.object({}),
          risk: 'write',
          execute,
        }),
      ],
      model: scriptedModel([toolCall('generated_write', {}), text('Done')]),
    });
    const sent = await s.call('POST', `/api/conversations/${s.main.id}/messages`, {
      token: s.member.token,
      body: { content: 'Generate a public artifact' },
    });
    await s.services.engine.idle();
    const [card] = await getDb().select().from(requests).where(eq(requests.runId, sent.body.run_id));
    expect(execute).not.toHaveBeenCalled();
    expect((await s.call('POST', `/api/requests/${card!.id}/approve`, { token: s.member.token })).status).toBe(200);
    await s.services.engine.idle();
    expect(execute).toHaveBeenCalledTimes(1);
    const [step] = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.toolName, 'generated_write')));
    const output = step!.output as Stored;
    expect((await s.services.files.get(s.member.id, output.file.id)).meta).toMatchObject({
      tool_output: { private: false },
    });
    const r = await s.run();
    await r.call('tool_output_read', { file_id: output.file.id });
    await expect(r.call('web_fetch', { url: 'https://example.com/follow-up' })).resolves.toBeTruthy();
  });

  it.each(['none', 'shared', 'per_member', 'oauth'] as const)(
    'preserves connector privacy for %s authentication',
    async (authMode) => {
      const s = await setup();
      const id = newId('connector');
      await getDb()
        .insert(connectors)
        .values({ id, slug: 'source', name: 'Source', url: 'https://example.com/mcp', authMode });
      const remote = {
        offered: async () => true,
        usable: async () => [],
        mine: s.services.connectors.mine,
        findTool: async () => ({ connector: { id, slug: 'source' }, tool: { name: 'read', readOnly: true } }),
        run: async () => ({ text: 'Source content. '.repeat(1000), isError: false }),
      } as unknown as ConnectorsService;
      const r = await s.run([connectorTool(remote)]);
      const output = (await r.call('mcp_call', {
        action: 'call',
        connector: 'source',
        tool: 'read',
        arguments: {},
      })) as Stored;
      const fresh = await s.run();
      await fresh.call('tool_output_read', { file_id: output.file.id });
      const next = fresh.call('web_fetch', { url: 'https://example.com/follow-up' });
      if (authMode === 'none') await expect(next).resolves.toBeTruthy();
      else await expect(next).rejects.toThrow('read private data');
    },
  );

  it('blocks the web after knowledge reads and after reading their stored output in another run', async () => {
    const s = await setup();
    const doc = await s.services.knowledge.createDoc(s.member.id, {
      title: 'Private',
      content: 'Private facts. '.repeat(1000),
    });
    const r = await s.run();
    const output = (await r.call('knowledge_query', { action: 'read', doc_id: doc.id })) as Stored;
    await expect(r.call('web_fetch', { url: 'https://example.com/leak' })).rejects.toThrow('read private data');
    const fresh = await s.run();
    await fresh.call('tool_output_read', { file_id: output.file.id });
    await expect(fresh.call('web_fetch', { url: 'https://example.com/leak' })).rejects.toThrow('read private data');
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.seal).toHaveBeenCalledTimes(2);
    expect((await getDb().select().from(runs).where(eq(runs.id, fresh.runId)))[0]!.checkpoint).toMatchObject({
      read_private: true,
    });
  });

  it('treats missing provenance as private and still checks output ownership', async () => {
    const s = await setup();
    const r = await s.run();
    const output = (await r.call('web_fetch', { url: 'https://example.com/pricing' })) as Stored;
    const other = await s.newMember();
    await expect(s.services.files.get(other.id, output.file.id)).rejects.toMatchObject({ code: 'not_found' });
    await getDb().update(files).set({ meta: {} }).where(eq(files.id, output.file.id));
    await r.call('tool_output_read', { file_id: output.file.id });
    await expect(r.call('web_fetch', { url: 'https://example.com/next' })).rejects.toThrow('read private data');
  });

  it('offers recall only to background models and rejects memory writes before recording a step', async () => {
    const s = await setup();
    const r = await s.run();
    const memory = r.tools.tools.memory!;
    const schema = memory.inputSchema as unknown as {
      jsonSchema: unknown;
      validate: (v: unknown) => Promise<{ success: boolean }>;
    };
    expect(await schema.jsonSchema).toMatchObject({ properties: { action: { const: 'recall' } } });
    for (const action of ['remember', 'update', 'forget'])
      expect(await schema.validate({ action, title: 'No writes', id: 'missing' })).toMatchObject({ success: false });
    await r.call('memory', { action: 'recall', query: 'nothing' });
    await expect(r.call('web_fetch', { url: 'https://example.com/leak' })).rejects.toThrow('read private data');
    expect((await getDb().select().from(runSteps).where(eq(runSteps.runId, r.runId))).map((s) => s.toolName)).toEqual([
      'memory',
    ]);
  });
});
