/**
 * Tests for the shared agent-runtime tool resolution extracted from the chat route.
 *
 * These cover the DB-free decision paths (internal users + custom profile
 * intersection) and the lazy server-tool gating, which is
 * the logic both /api/chat and /api/agent rely on.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveTools,
  buildLazyServerTools,
  LAZY_TOOL_IDS,
} from '../../../apps/api/src/agent-runtime/tool-resolution.js';
import { BUILTIN_AGENT_TOOL_IDS, getAllToolIds } from '../../../apps/api/src/tools/registry.js';
import type { AgentProfile } from '../../../apps/api/src/profiles/profile.js';

// Minimal AgentProfile factory — resolveEffectiveTools only reads tools.
function makeProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test',
    name: 'Test',
    system_prompt: '',
    access: { level: 'internal', rich_output: false },
    tools: [],
    ...overrides,
  } as AgentProfile;
}

describe('resolveEffectiveTools', () => {
  it('super user on an internal profile gets the full tool set (no profile narrowing)', async () => {
    const profile = makeProfile({
      access: { level: 'internal', rich_output: false },
      tools: ['knowledge_query'], // narrow declared list is ignored for internal profiles
    });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: 'super-1',
      userRole: 'super',
      profile,
      profileId: 'team',
    });

    // Internal non-custom profile → all the user's allowed tools.
    expect(effectiveTools.sort()).toEqual(getAllToolIds().sort());
  });

  it('custom profile narrows a super user down to the declared intersection', async () => {
    const profile = makeProfile({
      access: { level: 'internal', rich_output: false },
      tools: ['knowledge_query', 'analyze_image'],
    });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: 'super-1',
      userRole: 'super',
      profile,
      profileId: 'custom:1',
    });

    // Declared tools plus the built-ins every Agent carries: the profile still
    // narrows a super's full catalog, it just cannot narrow below the basics.
    expect(effectiveTools.sort()).toEqual(
      [...new Set(['analyze_image', 'knowledge_query', ...BUILTIN_AGENT_TOOL_IDS])].sort(),
    );
    expect(effectiveTools).not.toContain('tables_query');
  });

  it('expands retired tool ids saved in custom profiles to their successors', async () => {
    // Custom profiles persist tool id arrays in the DB. A saved agent listing the
    // retired project_manager / session_history / team_knowledge must keep working
    // through the successor pairs instead of silently losing the domain.
    const profile = makeProfile({
      access: { level: 'internal', rich_output: false },
      tools: ['project_manager', 'session_history', 'team_knowledge'],
    });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: 'super-1',
      userRole: 'super',
      profile,
      profileId: 'custom:legacy',
    });

    expect(effectiveTools.sort()).toEqual(
      [
        ...new Set([
          'project_query',
          'project_mutation',
          'session_query',
          'knowledge_query',
          ...BUILTIN_AGENT_TOOL_IDS,
        ]),
      ].sort(),
    );
  });

  it('hidden integration profile resolves only the bound internal user tool set', async () => {
    const profile = makeProfile({
      access: { level: 'hidden', rich_output: false },
      tools: [],
    });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: 'super-1',
      userRole: 'super',
      profile,
      profileId: 'desktop',
    });

    expect(effectiveTools.sort()).toEqual(getAllToolIds().sort());
  });
});

describe('buildLazyServerTools', () => {
  const db = {} as never; // factories build tool definitions lazily; no DB access at construct time
  const allLazy = [...LAZY_TOOL_IDS];

  it('injects all lazy server tools for an internal user', () => {
    const internal = buildLazyServerTools(db, allLazy, { userId: 'u1', userRole: 'team' });
    expect(internal).toHaveProperty('feature_request');
    expect(internal).toHaveProperty('knowledge_query');
    expect(internal).toHaveProperty('session_query');
  });
});
