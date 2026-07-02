/**
 * Tests for the shared agent-runtime tool resolution extracted from the chat route.
 *
 * These cover the DB-free decision paths (external/super users + profile
 * intersection) and the lazy server-tool gating, which is the logic both
 * /api/chat and /api/agent rely on.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveTools,
  buildLazyServerTools,
  LAZY_TOOL_IDS,
} from '../../../apps/api/src/agent-runtime/tool-resolution.js';
import { getGlobalToolIds, getAllToolIds, getSuperToolIds } from '../../../apps/api/src/tools/registry.js';
import type { AgentProfile } from '../../../apps/api/src/profile.js';

// Minimal AgentProfile factory — resolveEffectiveTools only reads access.level,
// desktop, and tools.
function makeProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test',
    name: 'Test',
    system_prompt: '',
    access: { level: 'internal', requires_session: false, rich_output: false },
    tools: [],
    ...overrides,
  } as AgentProfile;
}

describe('resolveEffectiveTools', () => {
  it('external user on a public profile gets global tools intersected with profile tools', async () => {
    const globalIds = getGlobalToolIds();
    // public profile declares a global tool + a non-global tool; only the global
    // one survives the intersection for an external user.
    const profile = makeProfile({
      access: { level: 'public', requires_session: false, rich_output: false },
      tools: [globalIds[0], 'external_search'],
    });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: null,
      userRole: 'external',
      profile,
      profileId: 'default',
    });

    expect(effectiveTools).toContain(globalIds[0]);
    expect(effectiveTools).not.toContain('external_search');
  });

  it('super user on an internal profile gets the full tool set (no profile narrowing)', async () => {
    const profile = makeProfile({
      access: { level: 'internal', requires_session: false, rich_output: false },
      tools: ['knowledge_query'], // narrow declared list is ignored for internal profiles
    });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: 'super-1',
      userRole: 'super',
      profile,
      profileId: 'team',
    });

    // Internal (non-public, non-custom) profile → all the user's allowed tools.
    expect(effectiveTools.sort()).toEqual(getAllToolIds().sort());
  });

  it('public profile narrows a super user down to the declared intersection', async () => {
    const profile = makeProfile({
      access: { level: 'public', requires_session: false, rich_output: false },
      tools: ['knowledge_query', 'analyze_image'],
    });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: 'super-1',
      userRole: 'super',
      profile,
      profileId: 'default',
    });

    expect(effectiveTools.sort()).toEqual(['analyze_image', 'knowledge_query']);
  });
});

describe('buildLazyServerTools', () => {
  const db = {} as never; // factories build tool definitions lazily; no DB access at construct time
  const allLazy = [...LAZY_TOOL_IDS];

  it('injects user-scoped tools only when a userId is present', () => {
    const anon = buildLazyServerTools(db, allLazy, { userId: null, userRole: 'external' });
    // feature_request / project_manager fall back to "anonymous" and are present
    expect(anon).toHaveProperty('feature_request');
    expect(anon).toHaveProperty('project_manager');
    // user-scoped tools require a userId
    expect(anon).not.toHaveProperty('email_manager');
    expect(anon).not.toHaveProperty('knowledge_query');
    expect(anon).not.toHaveProperty('session_history');
  });

  it('excludes session_history for the external pseudo-user', () => {
    const ext = buildLazyServerTools(db, allLazy, { userId: 'external', userRole: 'external' });
    expect(ext).not.toHaveProperty('session_history');
  });

  it('injects all lazy server tools for an internal user', () => {
    const internal = buildLazyServerTools(db, allLazy, { userId: 'u1', userRole: 'team' });
    expect(internal).toHaveProperty('feature_request');
    expect(internal).toHaveProperty('project_manager');
    expect(internal).toHaveProperty('email_manager');
    expect(internal).toHaveProperty('knowledge_query');
    expect(internal).toHaveProperty('session_history');
  });

  it('never builds a super-only tool for a non-super caller, even if it is in the id list', () => {
    // admin_analytics is category 'super' / requires.user 'super'. A team user must
    // not get it built even when it is present in the requested id list.
    expect(getSuperToolIds()).toContain('admin_analytics');
    const team = buildLazyServerTools(db, allLazy, { userId: 'u1', userRole: 'team' });
    expect(team).not.toHaveProperty('admin_analytics');
    const ext = buildLazyServerTools(db, allLazy, { userId: 'external', userRole: 'external' });
    expect(ext).not.toHaveProperty('admin_analytics');
  });

  it('builds super-only tools for a super caller', () => {
    const superTools = buildLazyServerTools(db, allLazy, { userId: 's1', userRole: 'super' });
    expect(superTools).toHaveProperty('admin_analytics');
  });
});
