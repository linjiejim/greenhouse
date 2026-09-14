/**
 * Cross-channel tool parity — the keystone test.
 *
 * "Which tools does this user get" must give the same answer on every channel.
 * Each channel composes the shared base its own way (chat: resolveEffectiveTools;
 * /api/agent: + proxy tiers; /api/mcp: + MCP surface + platform visibility), and
 * history shows drift happens exactly in those channel-local compositions — a
 * second hand-written flag→tool map in the MCP route, a raw isEnabled read in
 * the tool resolver. Every prior test pinned ONE channel; this file pins the
 * relations BETWEEN them, driving the real composition code of each.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

import { resolveProfileAsync } from '../../apps/api/src/profiles/profile.js';
import { resolveEffectiveTools } from '../../apps/api/src/agent-runtime/tool-resolution.js';
import {
  resolveProxyToolIds,
  MUTATING_PROXY_ALLOWLIST,
  READONLY_PROXY_ALLOWLIST,
} from '../../apps/api/src/agent-runtime/tool-proxy.js';
import type { AgentIdentity } from '../../apps/api/src/agent-runtime/api-auth.js';
import { MCP_RESOURCE_GROUP_IDS } from '@greenhouse/types/mcp';
import { mcpToolIdsForGroups } from '../../apps/api/src/tools/registry.js';
import { composeMcpContext, MCP_EXPOSED_TOOL_IDS } from '../../apps/api/src/routes/mcp.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../apps/api/src/platform/runtime.js';
import { projectsRegistration } from '../../apps/api/src/platform/projects/application.js';
import { knowledgeRegistration } from '../../apps/api/src/platform/knowledge/registration.js';
import { tablesRegistration } from '../../apps/api/src/platform/tables/application.js';

let db: DatabaseProvider;

/** Full-scope identity, as /api/agent's agentBearerAuthMiddleware builds it. */
function identityFor(user: UserRow): AgentIdentity {
  return {
    userId: user.id,
    userRole: user.role as AgentIdentity['userRole'],
    // A CLI / sandbox token acts as the user: no extra read narrowing at all.
    // (`[]` would mean the opposite — zero readable tools.)
    allowedTools: undefined,
    allowedWriteTools: [...MUTATING_PROXY_ALLOWLIST],
    allowedWorkspaces: [],
    credential: 'user',
    runId: null,
  };
}

/**
 * MCP identity for a grant covering every resource group — the parity baseline.
 * mcp-auth derives both lists from the granted `mcp:<group>` scopes, so any
 * narrower grant yields a strict subset of this.
 */
function mcpIdentityFor(user: UserRow): AgentIdentity {
  const groupTools = mcpToolIdsForGroups(MCP_RESOURCE_GROUP_IDS);
  return {
    ...identityFor(user),
    allowedTools: [...groupTools].filter((id) => !MUTATING_PROXY_ALLOWLIST.has(id)),
    allowedWriteTools: [...groupTools].filter((id) => MUTATING_PROXY_ALLOWLIST.has(id)),
  };
}

/** Compose all three channels' tool sets the way their routes do. */
async function channelSets(user: UserRow) {
  const profile = await resolveProfileAsync('desktop');
  const { effectiveTools } = await resolveEffectiveTools({
    userId: user.id,
    userRole: user.role,
    profile,
    profileId: 'desktop',
  });
  const identity = identityFor(user);
  const proxy = resolveProxyToolIds(effectiveTools, {
    allowedTools: identity.allowedTools,
    allowedWriteTools: identity.allowedWriteTools,
  });
  const mcp = (await composeMcpContext(mcpIdentityFor(user), {})).toolIds;
  return { chat: new Set(effectiveTools), proxy: new Set(proxy), mcp: new Set(mcp) };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

describe('cross-channel tool parity', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    // MCP's platform-visibility filter needs the runtime — same set as index.ts.
    initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration, tablesRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('narrows monotonically: mcp ⊆ proxy ⊆ chat, for team and super', async () => {
    for (const role of ['team', 'super'] as const) {
      const user = await createInternalTestUser(db, { email: uniqueEmail(`parity-${role}`), role });
      const { chat, proxy, mcp } = await channelSets(user);

      expect(chat.size).toBeGreaterThan(0);
      const proxyLeaks = [...proxy].filter((id) => !chat.has(id));
      const mcpLeaks = [...mcp].filter((id) => !proxy.has(id));
      expect(proxyLeaks, `proxy tools missing from chat (${role})`).toEqual([]);
      expect(mcpLeaks, `mcp tools missing from proxy (${role})`).toEqual([]);
    }
  });

  it('derives /api/agent exactly: proxy = chat ∩ (read ∪ write allowlists)', async () => {
    const user = await createInternalTestUser(db, { email: uniqueEmail('parity-derive') });
    const { chat, proxy } = await channelSets(user);

    const expected = [...chat].filter((id) => READONLY_PROXY_ALLOWLIST.has(id) || MUTATING_PROXY_ALLOWLIST.has(id));
    expect([...proxy].sort()).toEqual(expected.sort());
  });

  it('derives /api/mcp exactly: mcp = proxy ∩ MCP surface (baseline user, no platform denies)', async () => {
    const user = await createInternalTestUser(db, { email: uniqueEmail('parity-mcp') });
    const { proxy, mcp } = await channelSets(user);

    const expected = [...proxy].filter((id) => MCP_EXPOSED_TOOL_IDS.has(id));
    expect([...mcp].sort()).toEqual(expected.sort());
  });

  it('propagates a flag grant and its revocation to ALL channels on the next request', async () => {
    // tables (a default-on flag) is the pin for cache staleness: the old MCP
    // context cache only re-checked some apps on hit, so a revocation could
    // serve a stale tool list for up to 60s while chat/proxy had already
    // dropped it.
    const user = await createInternalTestUser(db, { email: uniqueEmail('parity-flag') });

    let sets = await channelSets(user);
    expect(sets.chat.has('tables_query')).toBe(true);
    expect(sets.proxy.has('tables_query')).toBe(true);
    expect(sets.mcp.has('tables_query')).toBe(true);

    await db.userFeatures.upsert({ user_id: user.id, feature: 'tables', enabled: false, granted_by: user.id });
    sets = await channelSets(user);
    expect(sets.chat.has('tables_query')).toBe(false);
    expect(sets.proxy.has('tables_query')).toBe(false);
    expect(sets.mcp.has('tables_query')).toBe(false);

    await db.userFeatures.upsert({ user_id: user.id, feature: 'tables', enabled: true, granted_by: user.id });
    sets = await channelSets(user);
    expect(sets.chat.has('tables_query')).toBe(true);
    expect(sets.proxy.has('tables_query')).toBe(true);
    expect(sets.mcp.has('tables_query')).toBe(true);
  });

  it('propagates a user_tools grant and revocation to chat immediately, never to surfaces it lacks', async () => {
    const user = await createInternalTestUser(db, { email: uniqueEmail('parity-assign') });

    await db.userTools.setTools(user.id, ['query_eval_runs'], user.id);
    let sets = await channelSets(user);
    expect(sets.chat.has('query_eval_runs')).toBe(true);
    // No proxy/MCP surface declared — never listed there, granted or not.
    expect(sets.proxy.has('query_eval_runs')).toBe(false);
    expect(sets.mcp.has('query_eval_runs')).toBe(false);

    await db.userTools.setTools(user.id, [], user.id);
    sets = await channelSets(user);
    expect(sets.chat.has('query_eval_runs')).toBe(false);
  });

  it('honors defaultEnabled at the tool layer (the isEnabled landmine)', async () => {
    // memory is default-ON with no row for anyone. A raw table read returns
    // false here; the resolver returns true. This is how memory v1 shipped dead.
    const user = await createInternalTestUser(db, { email: uniqueEmail('parity-default') });

    let sets = await channelSets(user);
    expect(sets.chat.has('memory')).toBe(true);

    await db.userFeatures.upsert({ user_id: user.id, feature: 'memory', enabled: false, granted_by: user.id });
    sets = await channelSets(user);
    expect(sets.chat.has('memory')).toBe(false);
  });

  it('keeps chat-only draft tools off the stateless channels (tables flag)', async () => {
    const user = await createInternalTestUser(db, { email: uniqueEmail('parity-tables') });
    await db.userFeatures.upsert({ user_id: user.id, feature: 'tables', enabled: true, granted_by: user.id });

    const { chat, proxy, mcp } = await channelSets(user);
    expect(chat.has('tables_schema_plan')).toBe(true);
    expect(proxy.has('tables_schema_plan')).toBe(false);
    expect(mcp.has('tables_schema_plan')).toBe(false);
    expect(mcp.has('tables_query')).toBe(true);
  });
});
