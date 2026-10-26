/**
 * Report templates and rendering over MCP (v1.7, group `reports`), driven
 * through the real MCP server (in-memory transport) on the real database,
 * plus the same tools as Chat builds them.
 *
 * Pinned here: which tools each grant lists and with which annotations
 * (report_render is an additive write: no confirm round trip); a template's
 * guidance and shapes reach the agent; validate checks without saving; a
 * refused render names every problem in its error text (over MCP a refused
 * write arrives as that one string) and saves nothing; a render saves a real
 * file to the member's personal shelf (or a team folder) as a recorded agent
 * write, with nothing metered.
 *
 * Storage is in memory: no disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';

vi.setConfig({ testTimeout: 30_000 });

const fakes = vi.hoisted(() => ({ objects: new Map<string, { buffer: Buffer; contentType: string }>() }));

vi.mock('../../../../apps/api/src/storage/uploads.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/api/src/storage/uploads.js')>();
  return {
    ...actual,
    putObjectAtKey: async (key: string, buffer: Buffer, contentType: string) =>
      void fakes.objects.set(key, { buffer, contentType }),
    getObjectAtKey: async (key: string) => fakes.objects.get(key) ?? null,
    deleteObjectAtKey: async (key: string) => void fakes.objects.delete(key),
    presignGetUrl: async (key: string) => `https://objects.test/${encodeURIComponent(key)}?sig=1`,
    listObjectKeys: async () => [...fakes.objects.keys()],
  };
});

import { buildMcpServer, composeMcpContext } from '../../../../apps/api/src/routes/mcp.js';
import { identityFromOAuthScopes } from '../../../../apps/api/src/agent-runtime/mcp-auth.js';
import { buildLazyServerTools, resolveEffectiveTools } from '../../../../apps/api/src/agent-runtime/tool-resolution.js';
import { resolveProfileAsync } from '../../../../apps/api/src/profiles/profile.js';
import { scheduledToolBase } from '../../../../apps/api/src/scheduler/executor.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../../../apps/api/src/platform/runtime.js';
import { projectsRegistration } from '../../../projects/api/platform/application.js';
import { knowledgeRegistration } from '../../../knowledge/api/platform/registration.js';
import { tablesRegistration } from '../../../tables/api/platform/application.js';
import { createTemplate } from '../templates.js';
import { listActivity } from '../../../../apps/api/src/activity/activity-log.js';

let db: DatabaseProvider;
let member: UserRow;
let clientId: string;
let templateId: string;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function connect(scopes: string[]) {
  const identity = identityFromOAuthScopes({ id: member.id, role: 'team' }, scopes);
  const ctx = await composeMcpContext(identity, {});
  const c = {
    get: (key: string) =>
      key === 'agentIdentity'
        ? identity
        : key === 'oauthClientId'
          ? clientId
          : key === 'oauthAuthMethod'
            ? 'oauth'
            : undefined,
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
  const server = buildMcpServer(c, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

const ALL = ['mcp:read', 'mcp:write', 'mcp:reports'];

const CONTENT = {
  template_id: '',
  cover: { title: '研发周报', period: '第 43 周' },
  sections: {
    summary: '本周完成了**报告模板**。',
    next_week: ['上线', '收集反馈'],
  },
};

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
  member = await createInternalTestUser(db, { email: `${unique('rpt-member')}@test.local` });
  clientId = unique('client');
  await db.platformOAuth.registerClient({
    id: clientId,
    client_name: 'Codex',
    redirect_uris: [],
    created_by: member.id,
  });
  fakes.objects.clear();
  const template = await createTemplate(
    db,
    { userId: member.id, role: 'team' },
    {
      name: unique('周报'),
      description: 'Weekly',
      kind: 'report',
      formats: ['pdf', 'docx'],
      visibility: 'team',
      cover_fields: [
        { key: 'title', required: true },
        { key: 'period', required: true },
      ],
      sections: [
        { key: 'summary', title: '本周摘要', guidance: '结论先行。', required: true, content: 'markdown' },
        { key: 'metrics', title: '关键数据', guidance: '', required: false, content: 'figures' },
        { key: 'next_week', title: '下周计划', guidance: '', required: true, content: 'bullets' },
      ],
    },
  );
  if (!template.ok) throw new Error(template.error);
  templateId = template.value.id;
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

async function agentWrites() {
  return (await db.runtime.listRuns({ owner_user_id: member.id, kinds: ['agent_write'], limit: 10 })).items;
}

describe('MCP report tools: listing', () => {
  it('lists report_templates with read scope and report_render only with mcp:write, annotated', async () => {
    const reader = await connect(['mcp:read', 'mcp:reports']);
    // team_context / data_catalog are protocol tools every grant lists (v1.7 hub context).
    const notContextTool = (name: string) => name !== 'team_context' && name !== 'data_catalog';
    expect(
      (await reader.listTools()).tools
        .map((tool) => tool.name)
        .filter(notContextTool)
        .sort(),
    ).toEqual(['report_templates', 'tool_output_read']);

    const writer = await connect(ALL);
    const tools = (await writer.listTools()).tools;
    expect(
      tools
        .map((tool) => tool.name)
        .filter(notContextTool)
        .sort(),
    ).toEqual(['report_render', 'report_templates', 'tool_output_read']);
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations.report_templates).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(annotations.report_render).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    const render = tools.find((tool) => tool.name === 'report_render')!;
    expect(Object.keys((render.inputSchema as { properties: object }).properties)).not.toContain('confirm');
  });

  it('lists no report tool for a grant without the reports group', async () => {
    const other = await connect(['mcp:read', 'mcp:write', 'mcp:files']);
    const names = (await other.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('report_templates');
    expect(names).not.toContain('report_render');
  });
});

describe('MCP report tools: reading and validating', () => {
  it('hands the agent the template with guidance and content shapes', async () => {
    const client = await connect(ALL);
    const listed = JSON.parse((await call(client, 'report_templates', { action: 'list' })).content[0]!.text) as {
      templates: Array<{ id: string; required_sections: string[] }>;
    };
    expect(listed.templates.find((t) => t.id === templateId)).toMatchObject({
      required_sections: ['summary', 'next_week'],
    });

    const got = JSON.parse(
      (await call(client, 'report_templates', { action: 'get', template_id: templateId })).content[0]!.text,
    ) as { template: { default_format: string; sections: Array<{ key: string; guidance: string; shape: string }> } };
    expect(got.template.default_format).toBe('pdf');
    expect(got.template.sections[0]).toMatchObject({ key: 'summary', guidance: '结论先行。' });
    expect(got.template.sections[1]!.shape).toContain('"label"');
  });

  it('validates without rendering, saving or recording anything', async () => {
    const client = await connect(ALL);
    const bad = JSON.parse(
      (
        await call(client, 'report_templates', {
          action: 'validate',
          template_id: templateId,
          cover: { title: 'x' },
          sections: { summary: 'x', extra: 'y' },
        })
      ).content[0]!.text,
    ) as { valid: boolean; issues: Array<{ path: string; problem: string }> };
    expect(bad.valid).toBe(false);
    expect(bad.issues.map((i) => [i.path, i.problem])).toEqual([
      ['cover.period', 'missing_cover_field'],
      ['sections.extra', 'unknown_section'],
      ['sections.next_week', 'missing'],
    ]);
    const good = JSON.parse(
      (
        await call(client, 'report_templates', {
          action: 'validate',
          ...CONTENT,
          template_id: templateId,
          format: 'docx',
        })
      ).content[0]!.text,
    );
    expect(good).toEqual({ valid: true, format: 'docx', sections: ['summary', 'next_week'] });
    expect(fakes.objects.size).toBe(0);
    expect(await agentWrites()).toEqual([]);
  });
});

describe('MCP report tools: rendering', () => {
  it('saves the report to the personal shelf as a recorded agent write, unmetered', async () => {
    const client = await connect(ALL);
    const result = await call(client, 'report_render', { ...CONTENT, template_id: templateId });
    expect(result.isError).toBeFalsy();
    const output = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(output).toMatchObject({
      success: true,
      format: 'pdf',
      download_url: expect.stringContaining('https://objects.test/'),
      download_expires_in_seconds: 300,
    });
    expect(result.content.at(-1)!.text).toMatch(/^Recorded in Greenhouse as write /);

    const file = await db.drive.getFile(output.file_id as number);
    expect(file).toMatchObject({ scope: 'kb', visibility: 'private', owner_user_id: member.id, status: 'active' });
    expect(file!.name).toBe('研发周报 第 43 周.pdf');
    expect(fakes.objects.get(file!.cos_key)!.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const runs = await agentWrites();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.input).toMatchObject({ tool_id: 'report_render', client_id: clientId });
    expect(runs[0]!.status).toBe('succeeded');

    // The activity log says what happened: the member's agent created that file.
    const activity = (await listActivity(db, member, { source: 'agent' }, { manifests: [] })).items;
    expect(activity[0]).toMatchObject({ module: 'files', target: { label: '研发周报 第 43 周.pdf' } });

    const metered = (await db.executeRaw(
      sql`SELECT count(*)::int AS n FROM usage_events WHERE kind = 'service' AND user_id = ${member.id}`,
    )) as Array<{ n: number }>;
    expect(metered[0]!.n).toBe(0);
  });

  it('saves a Word file into a team folder the member may write', async () => {
    const folder = await db.drive.createFolder({ scope: 'kb', name: unique('Reports'), visibility: 'team' });
    const client = await connect(ALL);
    const result = await call(client, 'report_render', {
      ...CONTENT,
      template_id: templateId,
      format: 'docx',
      shelf: 'team',
      folder_id: folder.id,
      file_name: 'Week 43',
    });
    const output = JSON.parse(result.content[0]!.text) as { file_id: number };
    const file = await db.drive.getFile(output.file_id);
    expect(file).toMatchObject({ visibility: 'team', folder_id: folder.id, name: 'Week 43.docx' });
    expect(fakes.objects.get(file!.cos_key)!.buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('refuses content that does not fit, naming every problem, and saves nothing', async () => {
    const client = await connect(ALL);
    const result = await call(client, 'report_render', {
      template_id: templateId,
      format: 'pptx',
      cover: { title: 'x' },
      sections: { summary: '', blockers: ['?'] },
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain('(5 problems)');
    expect(text).toContain('- format: Template');
    expect(text).toContain('- cover.period: The cover needs "period".');
    expect(text).toContain('- sections.blockers:');
    expect(text).toContain('- sections.summary: Required section "summary" (本周摘要) is empty.');
    expect(text).toContain('- sections.next_week: Required section "next_week" (下周计划) is missing.');
    expect(text).toContain('Sections of this template: summary (required) = markdown');
    expect(fakes.objects.size).toBe(0);
  });

  it("cannot render with another member's draft", async () => {
    const other = await createInternalTestUser(db, { email: `${unique('rpt-other')}@test.local` });
    const draft = await createTemplate(
      db,
      { userId: other.id, role: 'team' },
      {
        name: 'Private',
        kind: 'report',
        formats: ['pdf'],
        visibility: 'personal',
        sections: [{ key: 'a', title: 'A', required: true, content: 'markdown' }],
      },
    );
    if (!draft.ok) throw new Error(draft.error);
    const client = await connect(ALL);
    const result = await call(client, 'report_render', { template_id: draft.value.id, sections: { a: 'x' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No report template/);
  });
});

describe('report tools in Chat', () => {
  it('are part of every member’s tools, and Chat renders into Files the same way', async () => {
    const { effectiveTools } = await resolveEffectiveTools({
      userId: member.id,
      userRole: 'team',
      profile: await resolveProfileAsync('desktop'),
      profileId: 'desktop',
    });
    expect(effectiveTools).toEqual(expect.arrayContaining(['report_templates', 'report_render']));
    const tools = buildLazyServerTools(db, effectiveTools, { userId: member.id, userRole: 'team', sessionId: 'sess' });
    const render = tools.report_render as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    const output = (await render.execute(
      { ...CONTENT, template_id: templateId, format: 'docx' },
      { toolCallId: 't1', messages: [] },
    )) as { success: boolean; file: { url: string; shelf: string } };
    expect(output).toMatchObject({
      success: true,
      file: { shelf: 'personal', url: expect.stringContaining('#/files') },
    });
  });
});

describe('report tools in automations', () => {
  /** The tools a scheduled run gets, assembled the way scheduler/executor.ts does. */
  async function automationTools(grant: string[]) {
    const { effectiveTools } = await resolveEffectiveTools({
      userId: member.id,
      userRole: 'team',
      profile: await resolveProfileAsync('desktop'),
      profileId: 'desktop',
    });
    const ids = scheduledToolBase(effectiveTools, grant);
    return {
      ids,
      tools: buildLazyServerTools(db, ids, {
        userId: member.id,
        userRole: 'team',
        sessionId: 'task',
        unattended: true,
      }),
    };
  }
  type Exec = { execute: (input: unknown, options: unknown) => Promise<unknown> };
  const run = (tool: unknown, input: unknown) =>
    (tool as Exec).execute(input, { toolCallId: 'auto-1', messages: [] }) as Promise<Record<string, unknown>>;

  it('reads templates without a grant, renders only when the owner ticked report_render', async () => {
    const plain = await automationTools([]);
    expect(plain.ids).toContain('report_templates');
    expect(plain.ids).not.toContain('report_render');

    const granted = await automationTools(['report_render']);
    const output = await run(granted.tools.report_render, { ...CONTENT, template_id: templateId });
    expect(output).toMatchObject({ success: true, file: { shelf: 'personal' } });
    const file = await db.drive.getFile(output.file_id as number);
    expect(file).toMatchObject({ visibility: 'private', owner_user_id: member.id, uploaded_by: member.id });
  });

  it("saves into a team folder the owner may write, never into someone else's shelf", async () => {
    const { tools } = await automationTools(['report_render']);
    const teamFolder = await db.drive.createFolder({ scope: 'kb', name: unique('Weekly'), visibility: 'team' });
    const saved = await run(tools.report_render, {
      ...CONTENT,
      template_id: templateId,
      shelf: 'team',
      folder_id: teamFolder.id,
    });
    expect(await db.drive.getFile(saved.file_id as number)).toMatchObject({
      visibility: 'team',
      folder_id: teamFolder.id,
    });

    const other = await createInternalTestUser(db, { email: `${unique('rpt-auto-other')}@test.local` });
    const theirs = await db.drive.createFolder({
      scope: 'kb',
      name: unique('Private'),
      visibility: 'private',
      owner_user_id: other.id,
    });
    const refused = await run(tools.report_render, {
      ...CONTENT,
      template_id: templateId,
      shelf: 'personal',
      folder_id: theirs.id,
    });
    expect(refused.error).toMatch(/not saved: No folder/);
  });
});
