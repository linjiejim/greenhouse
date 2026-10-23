/**
 * Team context over MCP (v1.7), driven through the real MCP server (in-memory
 * transport) on the real database: the `greenhouse://context/*` resources,
 * MCP prompts (SkillHub skills + saved prompts) and the `team_context` tool.
 *
 * Pinned here: everything follows the grant's resource groups AND the member's
 * own permissions — no knowledge group (or a denied knowledge capability) means
 * no conventions or glossary and no knowledge documents as resources; no skills
 * group means no prompts; a picked document that is no longer team-visible is
 * never served; a skill still awaiting review and another member's private
 * prompt are never offered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { buildMcpServer, composeMcpContext } from '../../routes/mcp.js';
import { identityFromOAuthScopes } from '../../agent-runtime/mcp-auth.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { invalidateWorkspaceConfigCache } from '../../settings/workspace-config.js';
import { publishSkill } from '../../skills/center.js';
import { _resetSkillStoreForTests, _setSkillStoreForTests, type SkillStore } from '../../skills/store.js';

vi.setConfig({ testTimeout: 20_000 });

let db: DatabaseProvider;
let admin: UserRow;
let member: UserRow;
let other: UserRow;
let clientId: string;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function memoryStore(): SkillStore {
  const objects = new Map<string, string>();
  return {
    backend: 'local',
    async put(key, json) {
      objects.set(key, json);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

async function connect(user: UserRow, scopes: string[]) {
  const identity = identityFromOAuthScopes({ id: user.id, role: user.role as 'team' | 'super' }, scopes);
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

async function teamDoc(title: string, content: string, visibility: 'team' | 'private' = 'team') {
  return db.knowledgeBase.create({
    doc_id: unique('doc'),
    scope: 'shared',
    title,
    content,
    visibility,
    status: 'published',
    created_by: admin.id,
    owner_user_id: admin.id,
  });
}

async function setting(key: string, value: unknown) {
  await db.workspaceSettings.set(key, { value }, admin.id);
  invalidateWorkspaceConfigCache();
}

function skillMd(name: string, body: string, frontmatter = '') {
  return {
    path: 'SKILL.md',
    content: `---\nname: ${name}\ndescription: ${name} for the team\nversion: 0.1.0\n${frontmatter}---\n\n${body}\n`,
  };
}

async function callJson(client: Client, name: string) {
  const result = (await client.callTool({ name, arguments: {} })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

const FULL = ['mcp:read', 'mcp:knowledge', 'mcp:skills', 'mcp:tables'];
const TABLES_ONLY = ['mcp:read', 'mcp:tables'];

let conventions: Awaited<ReturnType<typeof teamDoc>>;
let glossary: Awaited<ReturnType<typeof teamDoc>>;
let laterPrivate: Awaited<ReturnType<typeof teamDoc>>;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
  _setSkillStoreForTests(memoryStore());
  invalidateWorkspaceConfigCache();
  admin = await createInternalTestUser(db, { email: `${unique('ctx-admin')}@test.local`, role: 'super' });
  member = await createInternalTestUser(db, { email: `${unique('ctx-member')}@test.local` });
  other = await createInternalTestUser(db, { email: `${unique('ctx-other')}@test.local` });
  clientId = unique('client');
  await db.platformOAuth.registerClient({
    id: clientId,
    client_name: 'Codex',
    redirect_uris: '[]',
    created_by: member.id,
  });

  conventions = await teamDoc('How we write', 'Write in plain Chinese. Marker CONVENTION-OK.');
  glossary = await teamDoc('Terms', 'GMV: gross merchandise value. Marker GLOSSARY-OK.');
  laterPrivate = await teamDoc('Old rules', 'Marker MUST-NOT-LEAK.');
  await setting('team_context.conventions', [conventions.doc_id, laterPrivate.doc_id]);
  await setting('team_context.glossary', glossary.doc_id);
  // Picked while team-visible, then made private: it must stop serving.
  await db.knowledgeBase.update(laterPrivate.id, { visibility: 'private' }, admin.id);
});

afterEach(async () => {
  invalidateWorkspaceConfigCache();
  _resetSkillStoreForTests();
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('team context resources', () => {
  it('lists overview, conventions and glossary for a grant with knowledge, and serves only team documents', async () => {
    const client = await connect(member, FULL);
    const uris = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(uris.slice(0, 3)).toEqual([
      'greenhouse://context/overview',
      'greenhouse://context/conventions',
      'greenhouse://context/glossary',
    ]);

    const conventionsText = (
      (await client.readResource({ uri: 'greenhouse://context/conventions' })).contents[0] as { text: string }
    ).text;
    expect(conventionsText).toContain('CONVENTION-OK');
    expect(conventionsText).not.toContain('MUST-NOT-LEAK');
    const glossaryText = (
      (await client.readResource({ uri: 'greenhouse://context/glossary' })).contents[0] as { text: string }
    ).text;
    expect(glossaryText).toContain('GLOSSARY-OK');

    const overview = (
      (await client.readResource({ uri: 'greenhouse://context/overview' })).contents[0] as { text: string }
    ).text;
    expect(overview).toContain('team_context');
    expect(overview).toContain('**knowledge**');
    expect(overview).toContain('How we write');
    expect(overview).not.toContain('Old rules');
  });

  it('gives a grant without the knowledge group only the overview — no conventions and no knowledge documents', async () => {
    const client = await connect(member, TABLES_ONLY);
    const uris = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(uris).toEqual(['greenhouse://context/overview']);
    await expect(client.readResource({ uri: 'greenhouse://context/conventions' })).rejects.toThrow(
      /Resource not found/,
    );
    await expect(client.readResource({ uri: `greenhouse://knowledge/doc/${conventions.doc_id}` })).rejects.toThrow(
      /Resource not found/,
    );
    const overview = (
      (await client.readResource({ uri: 'greenhouse://context/overview' })).contents[0] as { text: string }
    ).text;
    expect(overview).toContain('no knowledge access');
    expect(overview).not.toContain('How we write');
  });

  it('follows the member: a denied knowledge capability removes conventions even with the knowledge group', async () => {
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: member.id,
      capability: 'knowledge.*',
      effect: 'deny',
      reason: 'team context permission test',
    });
    const client = await connect(member, FULL);
    const uris = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(uris).toEqual(['greenhouse://context/overview']);
  });
});

describe('MCP prompts', () => {
  let ownPrompt: number;
  let sharedPrompt: number;
  let privatePrompt: number;

  beforeEach(async () => {
    const reviewed = await publishSkill(
      db,
      { userId: admin.id, role: 'super' },
      {
        name: 'weekly-report',
        files: [
          skillMd(
            'weekly-report',
            '# Weekly report\n\nWrite the weekly report for {{team}} covering {{week}}.',
            'variables:\n  - key: team\n    description: Which team\n    required: true\n  - key: week\n',
          ),
        ],
      },
    );
    expect(reviewed.ok).toBe(true);
    const row = await db.skills.getByName('weekly-report');
    await db.skills.setScanDecision(row!.id, { status: 'clean', reviewed_by: admin.id });
    const pending = await publishSkill(
      db,
      { userId: admin.id, role: 'super' },
      { name: 'not-reviewed-yet', files: [skillMd('not-reviewed-yet', 'Body')] },
    );
    expect(pending.ok).toBe(true);

    ownPrompt = (
      await db.userPrompts.create({
        user_id: member.id,
        title: 'Summarize {{topic}}',
        content: 'Summarize {{topic}} in three lines.',
        variables: JSON.stringify([{ key: 'topic', label: 'Topic', required: true }]),
      })
    ).id;
    sharedPrompt = (
      await db.userPrompts.create({ user_id: other.id, title: 'Team standup', content: 'Run standup', is_global: true })
    ).id;
    privatePrompt = (await db.userPrompts.create({ user_id: other.id, title: 'Mine only', content: 'secret' })).id;
  });

  it('offers reviewed skills and the member’s own and shared prompts, with their variables as arguments', async () => {
    const client = await connect(member, FULL);
    const { prompts } = await client.listPrompts();
    const names = prompts.map((prompt) => prompt.name);
    expect(names).toEqual(
      expect.arrayContaining(['skill-weekly-report', `prompt-${ownPrompt}`, `prompt-${sharedPrompt}`]),
    );
    expect(names).not.toContain('skill-not-reviewed-yet');
    expect(names).not.toContain(`prompt-${privatePrompt}`);
    expect(prompts.find((prompt) => prompt.name === 'skill-weekly-report')!.arguments).toEqual([
      { name: 'team', description: 'Which team', required: true },
      { name: 'week' },
    ]);
    expect(prompts.find((prompt) => prompt.name === `prompt-${ownPrompt}`)!.arguments).toEqual([
      { name: 'topic', description: 'Topic', required: true },
    ]);

    const skill = await client.getPrompt({ name: 'skill-weekly-report', arguments: { team: 'Growth' } });
    const text = (skill.messages[0]!.content as { text: string }).text;
    expect(text).toContain('Write the weekly report for Growth covering {{week}}.');
    expect(text).not.toContain('variables:');

    const saved = await client.getPrompt({ name: `prompt-${ownPrompt}`, arguments: { topic: 'Q3 sales' } });
    expect((saved.messages[0]!.content as { text: string }).text).toBe('Summarize Q3 sales in three lines.');

    await expect(client.getPrompt({ name: `prompt-${privatePrompt}` })).rejects.toThrow(/Prompt not found/);
    await expect(client.getPrompt({ name: 'skill-not-reviewed-yet' })).rejects.toThrow(/Prompt not found/);
  });

  it('offers nothing to a grant without the skills group', async () => {
    const client = await connect(member, TABLES_ONLY);
    expect((await client.listPrompts()).prompts).toEqual([]);
    await expect(client.getPrompt({ name: `prompt-${ownPrompt}` })).rejects.toThrow(/Prompt not found/);
  });
});

describe('team_context tool', () => {
  it('is listed for every grant, read-only', async () => {
    const client = await connect(member, TABLES_ONLY);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'team_context');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('returns the same bundle as the resources, cut to the grant', async () => {
    const full = await callJson(await connect(member, FULL), 'team_context');
    expect(full.you).toMatchObject({ role: 'member' });
    expect(full.conventions.map((doc: { title: string }) => doc.title)).toEqual(['How we write']);
    expect(full.conventions[0].content).toContain('CONVENTION-OK');
    expect(full.glossary.title).toBe('Terms');
    expect(full.access.map((entry: { group: string }) => entry.group)).toEqual(
      expect.arrayContaining(['knowledge', 'tables', 'skills']),
    );
    expect(JSON.stringify(full)).not.toContain('MUST-NOT-LEAK');

    const narrow = await callJson(await connect(member, TABLES_ONLY), 'team_context');
    expect(narrow.conventions).toBeNull();
    expect(narrow.glossary).toBeNull();
    expect(narrow.prompts).toBeNull();
    expect(narrow.access.map((entry: { group: string }) => entry.group)).toEqual(['tables']);
  });

  it('points a grant with the reports group at the team’s report templates, and only that grant', async () => {
    const withReports = await connect(member, [...FULL, 'mcp:reports']);
    const overview = (
      (await withReports.readResource({ uri: 'greenhouse://context/overview' })).contents[0] as { text: string }
    ).text;
    expect(overview).toContain('**reports**');
    expect(overview).toContain('report_templates list');
    const bundle = await callJson(withReports, 'team_context');
    expect(bundle.access.find((entry: { group: string }) => entry.group === 'reports').read).toContain(
      'report_templates',
    );
    expect(bundle.notes.join(' ')).toContain('report_templates');

    const without = await connect(member, FULL);
    const plain = (
      (await without.readResource({ uri: 'greenhouse://context/overview' })).contents[0] as { text: string }
    ).text;
    expect(plain).not.toContain('report_templates');
  });

  it('says so when no conventions are set up', async () => {
    await db.workspaceSettings.clear('team_context.conventions');
    await db.workspaceSettings.clear('team_context.glossary');
    invalidateWorkspaceConfigCache();
    const bundle = await callJson(await connect(member, FULL), 'team_context');
    expect(bundle.conventions).toEqual([]);
    expect(bundle.glossary).toBeNull();
    expect(bundle.notes[0]).toMatch(/No team conventions/);
  });
});
