/**
 * The paid services members' agents reach over MCP (v1.6, group `services`):
 * web_search, read_url, analyze_image and generate_image, driven through the
 * real MCP server (in-memory transport) on the real database.
 *
 * Pinned here: which tools each grant lists and with which annotations; every
 * call metered to the member with client `mcp` and the OAuth client id;
 * read_url refusing non-public addresses before anything is reserved or
 * fetched; generate_image saving into the member's personal Files shelf as a
 * recorded agent write; an over-budget call coming back as a tool error with
 * the bilingual refusal.
 *
 * The providers are fakes (search provider, page extractor, image endpoint,
 * vision model) and storage is in memory: no network, no disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

const fakes = vi.hoisted(() => ({
  objects: new Map<string, { buffer: Buffer; contentType: string }>(),
  search: vi.fn(),
  extract: vi.fn(),
  vision: vi.fn(),
  edits: [] as FormData[],
}));

vi.mock('../../storage/uploads.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/uploads.js')>();
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

vi.mock('../../tools/external-search/providers/tavily.js', () => ({
  createTavilyProvider: () => ({ name: 'tavily', search: fakes.search }),
}));

vi.mock('../../tools/external-search/extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tools/external-search/extractor.js')>();
  class FakeChain {
    get names() {
      return ['jina', 'local'];
    }
    extract(url: string) {
      return fakes.extract(url);
    }
  }
  return { ...actual, ContentExtractorChain: FakeChain };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: (...args: unknown[]) => fakes.vision(...args) };
});

import { buildMcpServer, composeMcpContext } from '../mcp.js';
import { identityFromOAuthScopes } from '../../agent-runtime/mcp-auth.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { uploadCabinetFile } from '../../drive/kb-cabinet.js';
import { delegatedAgentActor } from '../../platform/actor.js';
import { setPriceOverridesForTests } from '../../usage/pricing.js';

// A 1x1 PNG: real magic bytes, so the image paths accept it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

let db: DatabaseProvider;
let member: UserRow;
let clientId: string;
let orgScope: string;
const savedEnv = { ...process.env };

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

async function serviceFacts(service: string) {
  return (await db.executeRaw(
    sql`SELECT service, provider, client, oauth_client_id, units, cost_usd_micros FROM service_usage
        WHERE user_id = ${member.id} AND service = ${service} ORDER BY created_at`,
  )) as Array<Record<string, unknown>>;
}

const ALL = ['mcp:read', 'mcp:write', 'mcp:services'];

beforeEach(async () => {
  orgScope = unique('org');
  process.env.USAGE_BUDGET_ORG_SCOPE_ID = orgScope;
  process.env.IMAGE_BASE_URL = 'https://images.test/v1';
  process.env.IMAGE_API_KEY = 'image-test-key';
  process.env.MEDIA_BASE_URL = 'https://media.test/v1';
  process.env.MEDIA_API_KEY = 'media-test-key';
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
  member = await createInternalTestUser(db, { email: `${unique('svc-member')}@test.local` });
  clientId = unique('client');
  await db.platformOAuth.registerClient({
    id: clientId,
    client_name: 'Codex',
    redirect_uris: '[]',
    created_by: member.id,
  });
  fakes.objects.clear();
  fakes.edits.length = 0;
  fakes.search.mockReset().mockResolvedValue([{ title: 'Result', url: 'https://example.com/a', snippet: 'about a' }]);
  fakes.extract.mockReset().mockResolvedValue({
    title: 'Page',
    content: 'Readable page text',
    byteLength: 18,
    truncated: false,
    extractor: 'jina',
  });
  fakes.vision.mockReset().mockResolvedValue({ text: 'A tiny dot.', usage: { inputTokens: 120, outputTokens: 8 } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://images.test/v1/images/generations')) {
        return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
      }
      if (String(url).startsWith('https://images.test/v1/images/edits')) {
        fakes.edits.push(init?.body as FormData);
        return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  setPriceOverridesForTests([]);
  process.env = { ...savedEnv };
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('MCP service tools: listing', () => {
  it('lists the read services with read-only scope, and generate_image only with mcp:write', async () => {
    const readOnly = await connect(['mcp:read', 'mcp:services']);
    const names = (await readOnly.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['analyze_image', 'read_url', 'tool_output_read', 'web_search']);

    const writer = await connect(ALL);
    const tools = (await writer.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'analyze_image',
      'generate_image',
      'read_url',
      'tool_output_read',
      'web_search',
    ]);
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations.web_search).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(annotations.read_url).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(annotations.analyze_image).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(annotations.generate_image).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    // Only deletes take the confirm round trip; generating an image never does.
    const generate = tools.find((tool) => tool.name === 'generate_image')!;
    expect(Object.keys((generate.inputSchema as { properties: object }).properties)).not.toContain('confirm');
  });

  it('keeps generate_image, and only that, for a grant that still carries the retired image group', async () => {
    const legacy = await connect(['mcp:read', 'mcp:write', 'mcp:image']);
    const names = (await legacy.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['generate_image', 'tool_output_read']);
  });

  it('lists no service tool for a grant without the services group', async () => {
    const other = await connect(['mcp:read', 'mcp:write', 'mcp:files']);
    const names = (await other.listTools()).tools.map((tool) => tool.name);
    for (const service of ['web_search', 'read_url', 'analyze_image', 'generate_image']) {
      expect(names).not.toContain(service);
    }
  });
});

describe('MCP service tools: metering', () => {
  it('meters a web search to the member, as client mcp with the OAuth client id', async () => {
    const client = await connect(ALL);
    const result = await call(client, 'web_search', { query: 'greenhouse' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      provider: 'tavily',
      results: [{ title: 'Result', url: 'https://example.com/a' }],
    });
    const facts = await serviceFacts('web_search');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ provider: 'tavily', client: 'mcp', oauth_client_id: clientId });
    expect(Number(facts[0]!.cost_usd_micros)).toBe(8_000);
  });

  it('meters a page read the same way', async () => {
    const client = await connect(ALL);
    const result = await call(client, 'read_url', { url: 'https://example.com/a' });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ url: 'https://example.com/a', title: 'Page' });
    expect(fakes.extract).toHaveBeenCalledWith('https://example.com/a');
    expect(await serviceFacts('page_read')).toEqual([
      expect.objectContaining({ provider: 'jina', client: 'mcp', oauth_client_id: clientId }),
    ]);
  });

  it('analyzes an image from Files and meters the vision call to the member and the agent', async () => {
    const caller = { db, userId: member.id, actor: delegatedAgentActor({ userId: member.id }) };
    const uploaded = await uploadCabinetFile(caller, { shelf: 'personal', name: 'dot.png', bytes: PNG });
    if ('error' in uploaded) throw new Error(uploaded.error);

    const client = await connect(ALL);
    const result = await call(client, 'analyze_image', { file_id: uploaded.file.id, question: 'What is it?' });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ description: 'A tiny dot.' });
    const rows = (await db.executeRaw(
      sql`SELECT service, client, oauth_client_id FROM llm_usage WHERE user_id = ${member.id}`,
    )) as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ service: 'vision', client: 'mcp', oauth_client_id: clientId }]);
  });

  it("refuses another member's private file", async () => {
    const other = await createInternalTestUser(db, { email: `${unique('svc-other')}@test.local` });
    const caller = { db, userId: other.id, actor: delegatedAgentActor({ userId: other.id }) };
    const uploaded = await uploadCabinetFile(caller, { shelf: 'personal', name: 'secret.png', bytes: PNG });
    if ('error' in uploaded) throw new Error(uploaded.error);

    const client = await connect(ALL);
    const result = await call(client, 'analyze_image', { file_id: uploaded.file.id });
    expect(result.content[0]!.text).toMatch(/No file with id/);
    expect(fakes.vision).not.toHaveBeenCalled();
  });

  it('generates an image into the personal Files shelf as a recorded agent write, metered', async () => {
    const client = await connect(ALL);
    const result = await call(client, 'generate_image', {
      action: 'generate',
      prompt: 'a seedling',
      size: '1536x1024',
    });
    expect(result.isError).toBeFalsy();
    const output = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(output).toMatchObject({ success: true, download_url: expect.stringContaining('https://objects.test/') });
    expect(output.url).toBeUndefined();
    expect(result.content.at(-1)!.text).toMatch(/^Recorded in Greenhouse as write /);

    const file = await db.drive.getFile(output.file_id as number);
    expect(file).toMatchObject({ scope: 'kb', visibility: 'private', owner_user_id: member.id, status: 'active' });
    expect(fakes.objects.get(file!.cos_key)?.buffer.equals(PNG)).toBe(true);

    const runs = (await db.runtime.listRuns({ owner_user_id: member.id, kinds: ['agent_write'], limit: 10 })).items;
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.input)).toMatchObject({ tool_id: 'generate_image', client_id: clientId, risk: 'r2' });
    expect(runs[0]!.status).toBe('succeeded');

    const facts = await serviceFacts('image_generation');
    expect(facts).toEqual([expect.objectContaining({ provider: 'media', client: 'mcp', oauth_client_id: clientId })]);
    expect(Number(facts[0]!.cost_usd_micros)).toBe(5_000);
  });

  it('edits an image it generated into Files, by file id', async () => {
    const client = await connect(ALL);
    const generated = await call(client, 'generate_image', { action: 'generate', prompt: 'a seedling' });
    const { file_id: fileId } = JSON.parse(generated.content[0]!.text) as { file_id: number };

    const edited = await call(client, 'generate_image', { action: 'edit', prompt: 'make it red', file_ids: [fileId] });
    expect(edited.isError).toBeFalsy();
    const output = JSON.parse(edited.content[0]!.text) as Record<string, unknown>;
    expect(output).toMatchObject({ success: true, reference_images: [`files:${fileId}`] });
    expect(output.file_id).not.toBe(fileId);
    expect(fakes.edits).toHaveLength(1);
    const sent = fakes.edits[0]!.getAll('image') as File[];
    expect(sent).toHaveLength(1);
    expect(Buffer.from(await sent[0]!.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("refuses another member's private file as a reference before anything is charged", async () => {
    const other = await createInternalTestUser(db, { email: `${unique('svc-ref-other')}@test.local` });
    const caller = { db, userId: other.id, actor: delegatedAgentActor({ userId: other.id }) };
    const uploaded = await uploadCabinetFile(caller, { shelf: 'personal', name: 'private.png', bytes: PNG });
    if ('error' in uploaded) throw new Error(uploaded.error);

    const client = await connect(ALL);
    const result = await call(client, 'generate_image', {
      action: 'edit',
      prompt: 'use it',
      file_ids: [uploaded.file.id],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/No file with id/);
    expect(fakes.edits).toHaveLength(0);
    expect(await serviceFacts('image_generation')).toEqual([]);
  });

  it('returns an over-budget refusal as a tool error in both languages', async () => {
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 0 });
    const client = await connect(ALL);
    const result = await call(client, 'web_search', { query: 'anything' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/额度/);
    expect(result.content[0]!.text).toMatch(/budget/i);
    expect(fakes.search).not.toHaveBeenCalled();
  });
});

describe('read_url SSRF guard', () => {
  it.each([
    'http://127.0.0.1:8080/admin',
    'http://localhost/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'https://user:pass@example.com/',
    'file:///etc/passwd',
  ])('refuses %s before reserving or fetching anything', async (url) => {
    const client = await connect(ALL);
    const result = await call(client, 'read_url', { url });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: expect.stringMatching(/public/) });
    expect(fakes.extract).not.toHaveBeenCalled();
    expect(await serviceFacts('page_read')).toEqual([]);
  });
});
