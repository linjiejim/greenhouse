/**
 * Knowledge Platform migration parity/security tests (real PostgreSQL).
 *
 * Web, Agent Tool and MCP Resource projections must resolve the same team,
 * owner, reader-share and editor-share access without leaking private slugs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  _resetProvider,
  initDatabase,
  type DatabaseProvider,
  type KnowledgeDocRow,
  type UserRow,
} from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import knowledgeRoutes from '../knowledge.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createKnowledgeQueryTool } from '../../tools/knowledge-query.js';
import { createKnowledgeMutationTool } from '../../tools/knowledge-mutation.js';
import { buildMcpServer, filterMcpToolIdsByPlatform } from '../mcp.js';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let directReader: UserRow;
let sharedEditor: UserRow;
let outsider: UserRow;
let teamDoc: KnowledgeDocRow;
let directDoc: KnowledgeDocRow;
let editorDoc: KnowledgeDocRow;
let ownerReady: Promise<UserRow> | undefined;
let directReaderReady: Promise<UserRow> | undefined;
let sharedEditorReady: Promise<UserRow> | undefined;
let outsiderReady: Promise<UserRow> | undefined;
let teamDocReady: Promise<KnowledgeDocRow> | undefined;
let directDocReady: Promise<KnowledgeDocRow> | undefined;
let editorDocReady: Promise<KnowledgeDocRow> | undefined;
let directShareReady: Promise<void> | undefined;
let editorShareReady: Promise<void> | undefined;

async function createUser(email: string) {
  return createInternalTestUser(db, { email });
}

function setupOwner(): Promise<UserRow> {
  ownerReady ??= createUser('knowledge-owner@test.com').then((created) => {
    owner = created;
    return created;
  });
  return ownerReady;
}

function setupDirectReader(): Promise<UserRow> {
  directReaderReady ??= createUser('knowledge-reader@test.com').then((created) => {
    directReader = created;
    return created;
  });
  return directReaderReady;
}

function setupSharedEditor(): Promise<UserRow> {
  sharedEditorReady ??= createUser('knowledge-editor@test.com').then((created) => {
    sharedEditor = created;
    return created;
  });
  return sharedEditorReady;
}

function setupOutsider(): Promise<UserRow> {
  outsiderReady ??= createUser('knowledge-outsider@test.com').then((created) => {
    outsider = created;
    return created;
  });
  return outsiderReady;
}

async function createDoc(slug: string, visibility: 'team' | 'private') {
  await setupOwner();
  return db.knowledgeBase.create({
    doc_id: slug,
    title: slug,
    content: `# ${slug}\n\nprivate marker ${slug}`,
    visibility,
    status: 'published',
    owner_user_id: owner.id,
    created_by: owner.id,
  });
}

function setupTeamDoc(): Promise<KnowledgeDocRow> {
  teamDocReady ??= createDoc('team-handbook', 'team').then((created) => {
    teamDoc = created;
    return created;
  });
  return teamDocReady;
}

function setupDirectDoc(): Promise<KnowledgeDocRow> {
  directDocReady ??= createDoc('direct-secret', 'private').then((created) => {
    directDoc = created;
    return created;
  });
  return directDocReady;
}

function setupEditorDoc(): Promise<KnowledgeDocRow> {
  editorDocReady ??= createDoc('editor-secret', 'private').then((created) => {
    editorDoc = created;
    return created;
  });
  return editorDocReady;
}

function setupDirectShare(): Promise<void> {
  directShareReady ??= Promise.all([setupDirectDoc(), setupDirectReader()]).then(async () => {
    await db.knowledgeShares.grant(directDoc.id, directReader.id, 'reader', owner.id);
  });
  return directShareReady;
}

function setupEditorShare(): Promise<void> {
  editorShareReady ??= Promise.all([setupEditorDoc(), setupSharedEditor(), setupOwner()]).then(async () => {
    await db.knowledgeShares.grant(editorDoc.id, sharedEditor.id, 'editor', owner.id);
  });
  return editorShareReady;
}

async function setupFullSharingScenario(): Promise<void> {
  await Promise.all([setupTeamDoc(), setupDirectShare(), setupEditorShare(), setupOutsider()]);
}

function createHttpApp(users: UserRow[]) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/knowledge', knowledgeRoutes);
  return app;
}

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const executable = tool as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return executable.execute(input, { toolCallId: 'knowledge-platform-test', messages: [] });
}

/** Knowledge resource URIs only — the server also lists the team-context resources. */
function knowledgeUris(resources: Array<{ uri: string }>): string[] {
  return resources.map((resource) => resource.uri).filter((uri) => uri.startsWith('greenhouse://knowledge/'));
}

// The grant reaches the knowledge tools (resources follow the same scopes as tools).
async function connectResources(user: UserRow, toolIds: string[] = ['knowledge_query']) {
  const fakeContext = {
    get: (key: string) =>
      key === 'agentIdentity'
        ? {
            userId: user.id,
            userRole: user.role,
            allowedTools: [],
            allowedWriteTools: [],
            allowedWorkspaces: [],
          }
        : undefined,
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
  const server = buildMcpServer(fakeContext, { toolIds, registry: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'knowledge-resource-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('Knowledge Platform migration', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    ownerReady = undefined;
    directReaderReady = undefined;
    sharedEditorReady = undefined;
    outsiderReady = undefined;
    teamDocReady = undefined;
    directDocReady = undefined;
    editorDocReady = undefined;
    directShareReady = undefined;
    editorShareReady = undefined;
    initializePlatformRuntime(db, [knowledgeRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('keeps reader and editor sharing consistent across Web, Tool and MCP Resources', async () => {
    await setupFullSharingScenario();
    const app = createHttpApp([owner, directReader, sharedEditor, outsider]);
    const directList = await app.request('/api/knowledge/docs', {
      headers: { 'x-test-user': directReader.id },
    });
    expect(directList.status).toBe(200);
    const directSlugs = ((await directList.json()) as { docs: Array<{ slug: string }> }).docs.map((doc) => doc.slug);
    expect(directSlugs).toEqual(expect.arrayContaining([teamDoc.doc_id, directDoc.doc_id]));
    expect(directSlugs).not.toContain(editorDoc.doc_id);

    const editorList = await app.request('/api/knowledge/docs', {
      headers: { 'x-test-user': sharedEditor.id },
    });
    const editorSlugs = ((await editorList.json()) as { docs: Array<{ slug: string }> }).docs.map((doc) => doc.slug);
    expect(editorSlugs).toEqual(expect.arrayContaining([teamDoc.doc_id, editorDoc.doc_id]));
    expect(editorSlugs).not.toContain(directDoc.doc_id);

    const directTool = await executeTool(createKnowledgeQueryTool(db, { userId: directReader.id }), {
      action: 'list',
      scope: 'shared',
    });
    expect(directTool).toMatchObject({
      found: 1,
      results: [expect.objectContaining({ doc_id: directDoc.doc_id })],
    });

    const { client, server } = await connectResources(sharedEditor);
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        `greenhouse://knowledge/doc/${teamDoc.doc_id}`,
        `greenhouse://knowledge/doc/${editorDoc.doc_id}`,
      ]),
    );
    expect(resources.resources.map((resource) => resource.uri)).not.toContain(
      `greenhouse://knowledge/doc/${directDoc.doc_id}`,
    );
    const read = await client.readResource({ uri: `greenhouse://knowledge/doc/${editorDoc.doc_id}` });
    expect(read.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect((read.contents[0] as { text?: string }).text).toContain(`private marker ${editorDoc.doc_id}`);
    await client.close();
    await server.close();
  });

  it('returns not-found and omits metadata when a private Resource URI is probed', async () => {
    await Promise.all([setupTeamDoc(), setupDirectDoc(), setupOutsider()]);
    const app = createHttpApp([owner, outsider]);
    const http = await app.request(`/api/knowledge/docs/${directDoc.doc_id}`, {
      headers: { 'x-test-user': outsider.id },
    });
    expect(http.status).toBe(404);

    const { client, server } = await connectResources(outsider);
    const resources = await client.listResources();
    expect(knowledgeUris(resources.resources)).toEqual([`greenhouse://knowledge/doc/${teamDoc.doc_id}`]);
    await expect(client.readResource({ uri: `greenhouse://knowledge/doc/${directDoc.doc_id}` })).rejects.toThrow(
      /Resource not found/,
    );
    await client.close();
    await server.close();
  });

  it('intersects platform capability denial with every transport', async () => {
    await setupDirectReader();
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: directReader.id,
      capability: 'knowledge.*',
      effect: 'deny',
      reason: 'Knowledge transport parity test',
    });
    const app = createHttpApp([directReader]);
    const http = await app.request('/api/knowledge/docs', {
      headers: { 'x-test-user': directReader.id },
    });
    expect(http.status).toBe(403);

    const tool = await executeTool(createKnowledgeQueryTool(db, { userId: directReader.id }), {
      action: 'list',
      scope: 'shared',
    });
    expect(tool).toMatchObject({ error: expect.stringMatching(/knowledge\.library\.read/) });

    expect(
      await filterMcpToolIdsByPlatform(
        {
          userId: directReader.id,
          userRole: 'team',
          allowedTools: [],
          allowedWriteTools: [],
          allowedWorkspaces: [],
        },
        ['knowledge_query', 'knowledge_mutation', 'session_query'],
      ),
    ).toEqual(['session_query']);

    const { client, server } = await connectResources(directReader);
    expect(knowledgeUris((await client.listResources()).resources)).toEqual([]);
    await client.close();
    await server.close();

    const audits = await db.platform.listAuditEvents('default', 20);
    expect(
      audits.some(
        (event) =>
          event.actor_id === directReader.id &&
          event.capability === 'knowledge.library.read' &&
          event.result === 'denied',
      ),
    ).toBe(true);
  });

  it('audits the document a create made and marks an editor heartbeat as no change', async () => {
    await setupOwner();
    const app = createHttpApp([owner]);
    const created = await app.request('/api/knowledge/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ title: `Audit me ${Date.now()}`, content: 'x' }),
    });
    expect(created.status).toBe(201);
    const docId = ((await created.json()) as { doc: { id: number } }).doc.id;
    await app.request(`/api/knowledge/docs/${docId}/editing-presence`, {
      method: 'POST',
      headers: { 'x-test-user': owner.id },
    });

    const audits = (await db.platform.listAuditEvents('default', 50)).filter((event) => event.actor_id === owner.id);
    const create = audits.find((event) => event.action_id === 'createDocument' && event.result === 'success');
    expect(create?.record_id).toBe(String(docId));
    const beat = audits.find((event) => JSON.parse(event.summary).change === 'presence');
    expect(JSON.parse(beat!.summary)).toMatchObject({ activity: false });
  });

  it('allows shared editors to write while reader grants remain read-only', async () => {
    await Promise.all([setupDirectShare(), setupEditorShare()]);
    const app = createHttpApp([directReader, sharedEditor]);
    const denied = await app.request(`/api/knowledge/docs/${directDoc.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': directReader.id },
      body: JSON.stringify({ title: 'Reader must not edit' }),
    });
    expect(denied.status).toBe(404);

    const updated = await executeTool(createKnowledgeMutationTool(db, { userId: sharedEditor.id }), {
      action: 'knowledge.update_doc',
      scope: 'personal',
      doc_id: editorDoc.doc_id,
      title: 'Updated by shared editor',
    });
    expect(updated).toMatchObject({
      status: 'updated',
      document: expect.objectContaining({ title: 'Updated by shared editor' }),
    });

    const readerTool = await executeTool(createKnowledgeMutationTool(db, { userId: directReader.id }), {
      action: 'knowledge.update_doc',
      scope: 'personal',
      doc_id: directDoc.doc_id,
      title: 'Still forbidden',
    });
    expect(readerTool).toMatchObject({ error: `Document not found: ${directDoc.doc_id}` });
  });

  it('scopes unified search to shared-with-me and never leaks ungranted private docs', async () => {
    await Promise.all([setupDirectShare(), setupEditorShare(), setupOutsider()]);
    const app = createHttpApp([owner, directReader, sharedEditor, outsider]);
    const search = async (user: UserRow, scope: string) => {
      const res = await app.request(`/api/knowledge/search?q=secret&scope=${scope}`, {
        headers: { 'x-test-user': user.id },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { results: Array<{ slug: string; scope: string; access: string }> }).results;
    };

    // Direct reader: only the doc granted to them (as a reader), nothing else.
    const readerHits = await search(directReader, 'shared');
    expect(readerHits.map((r) => r.slug)).toEqual([directDoc.doc_id]);
    expect(readerHits[0]).toMatchObject({ scope: 'shared', access: 'reader' });

    // Shared editor: the editor-shared doc, resolved to the editor role.
    const editorHits = await search(sharedEditor, 'shared');
    expect(editorHits.map((r) => r.slug)).toEqual([editorDoc.doc_id]);
    expect(editorHits[0]).toMatchObject({ scope: 'shared', access: 'editor' });

    // Outsider with no grant → empty shared channel (the leak guard).
    expect(await search(outsider, 'shared')).toEqual([]);
    // Owner is excluded from shared-with-me — those are their own docs.
    expect(await search(owner, 'shared')).toEqual([]);

    // scope=all folds the shared channel in without dropping the grant.
    const readerAll = await search(directReader, 'all');
    expect(readerAll.map((r) => r.slug)).toContain(directDoc.doc_id);
    // Default (no scope) keeps the legacy behaviour: shared docs never appear.
    const readerDefault = await search(directReader, '');
    expect(readerDefault.map((r) => r.slug)).not.toContain(directDoc.doc_id);
  });
});
