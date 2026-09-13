/**
 * Knowledge Platform migration parity/security tests (real PostgreSQL).
 *
 * Web, Agent Tool and MCP Resource projections must resolve the same team,
 * owner, direct-share and group-share access without leaking private slugs.
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
let groupEditor: UserRow;
let outsider: UserRow;
let teamDoc: KnowledgeDocRow;
let directDoc: KnowledgeDocRow;
let groupDoc: KnowledgeDocRow;
let ownerReady: Promise<UserRow> | undefined;
let directReaderReady: Promise<UserRow> | undefined;
let groupEditorReady: Promise<UserRow> | undefined;
let outsiderReady: Promise<UserRow> | undefined;
let teamDocReady: Promise<KnowledgeDocRow> | undefined;
let directDocReady: Promise<KnowledgeDocRow> | undefined;
let groupDocReady: Promise<KnowledgeDocRow> | undefined;
let directShareReady: Promise<void> | undefined;
let groupShareReady: Promise<void> | undefined;

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

function setupGroupEditor(): Promise<UserRow> {
  groupEditorReady ??= createUser('knowledge-group@test.com').then((created) => {
    groupEditor = created;
    return created;
  });
  return groupEditorReady;
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

function setupGroupDoc(): Promise<KnowledgeDocRow> {
  groupDocReady ??= createDoc('group-secret', 'private').then((created) => {
    groupDoc = created;
    return created;
  });
  return groupDocReady;
}

function setupDirectShare(): Promise<void> {
  directShareReady ??= Promise.all([setupDirectDoc(), setupDirectReader()]).then(async () => {
    await db.knowledgeShares.grant(directDoc.id, directReader.id, 'reader', owner.id);
  });
  return directShareReady;
}

function setupGroupShare(): Promise<void> {
  groupShareReady ??= Promise.all([setupGroupDoc(), setupGroupEditor(), setupOwner()]).then(async () => {
    const group = await db.groups.create({ name: 'Knowledge editors', created_by: owner.id });
    await db.groups.addMembers(group.id, [groupEditor.id], owner.id);
    await db.knowledgeShares.grant(groupDoc.id, `group:${group.id}`, 'editor', owner.id);
  });
  return groupShareReady;
}

async function setupFullSharingScenario(): Promise<void> {
  await Promise.all([setupTeamDoc(), setupDirectShare(), setupGroupShare(), setupOutsider()]);
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

async function connectResources(user: UserRow) {
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
  const server = buildMcpServer(fakeContext, { toolIds: [], registry: {} });
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
    groupEditorReady = undefined;
    outsiderReady = undefined;
    teamDocReady = undefined;
    directDocReady = undefined;
    groupDocReady = undefined;
    directShareReady = undefined;
    groupShareReady = undefined;
    initializePlatformRuntime(db, [knowledgeRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('keeps direct and group sharing consistent across Web, Tool and MCP Resources', async () => {
    await setupFullSharingScenario();
    const app = createHttpApp([owner, directReader, groupEditor, outsider]);
    const directList = await app.request('/api/knowledge/docs', {
      headers: { 'x-test-user': directReader.id },
    });
    expect(directList.status).toBe(200);
    const directSlugs = ((await directList.json()) as { docs: Array<{ slug: string }> }).docs.map((doc) => doc.slug);
    expect(directSlugs).toEqual(expect.arrayContaining([teamDoc.doc_id, directDoc.doc_id]));
    expect(directSlugs).not.toContain(groupDoc.doc_id);

    const groupList = await app.request('/api/knowledge/docs', {
      headers: { 'x-test-user': groupEditor.id },
    });
    const groupSlugs = ((await groupList.json()) as { docs: Array<{ slug: string }> }).docs.map((doc) => doc.slug);
    expect(groupSlugs).toEqual(expect.arrayContaining([teamDoc.doc_id, groupDoc.doc_id]));
    expect(groupSlugs).not.toContain(directDoc.doc_id);

    const directTool = await executeTool(createKnowledgeQueryTool(db, { userId: directReader.id }), {
      action: 'list',
      scope: 'shared',
    });
    expect(directTool).toMatchObject({
      found: 1,
      results: [expect.objectContaining({ doc_id: directDoc.doc_id })],
    });

    const { client, server } = await connectResources(groupEditor);
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        `greenhouse://knowledge/doc/${teamDoc.doc_id}`,
        `greenhouse://knowledge/doc/${groupDoc.doc_id}`,
      ]),
    );
    expect(resources.resources.map((resource) => resource.uri)).not.toContain(
      `greenhouse://knowledge/doc/${directDoc.doc_id}`,
    );
    const read = await client.readResource({ uri: `greenhouse://knowledge/doc/${groupDoc.doc_id}` });
    expect(read.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect((read.contents[0] as { text?: string }).text).toContain(`private marker ${groupDoc.doc_id}`);
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
    expect(resources.resources.map((resource) => resource.uri)).toEqual([
      `greenhouse://knowledge/doc/${teamDoc.doc_id}`,
    ]);
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
    expect((await client.listResources()).resources).toEqual([]);
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

  it('allows group editors to write while reader grants remain read-only', async () => {
    await Promise.all([setupDirectShare(), setupGroupShare()]);
    const app = createHttpApp([directReader, groupEditor]);
    const denied = await app.request(`/api/knowledge/docs/${directDoc.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': directReader.id },
      body: JSON.stringify({ title: 'Reader must not edit' }),
    });
    expect(denied.status).toBe(404);

    const updated = await executeTool(createKnowledgeMutationTool(db, { userId: groupEditor.id }), {
      action: 'knowledge.update_doc',
      scope: 'personal',
      doc_id: groupDoc.doc_id,
      title: 'Updated by group editor',
    });
    expect(updated).toMatchObject({
      status: 'updated',
      document: expect.objectContaining({ title: 'Updated by group editor' }),
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
    await Promise.all([setupDirectShare(), setupGroupShare(), setupOutsider()]);
    const app = createHttpApp([owner, directReader, groupEditor, outsider]);
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

    // Group editor: the group-shared doc, resolved to the editor role.
    const groupHits = await search(groupEditor, 'shared');
    expect(groupHits.map((r) => r.slug)).toEqual([groupDoc.doc_id]);
    expect(groupHits[0]).toMatchObject({ scope: 'shared', access: 'editor' });

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
