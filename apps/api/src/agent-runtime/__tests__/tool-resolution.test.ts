import { LAZY_TOOL_IDS } from '../../tools/registry.js';
/**
 * Tests for the profile↔user tool intersection boundary.
 *
 * Internal system profiles use the user's full allow-set, while custom profiles
 * can only narrow that set. The resolver must not expose a second, un-narrowed
 * result that could later leak into prompts.
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { normalizeAutomationOptInTools } from '@greenhouse/types/automation-tools';
import { resolveEffectiveTools, buildLazyServerTools } from '../tool-resolution.js';
import { BUILTIN_AGENT_TOOL_IDS, getAllToolIds } from '../../tools/registry.js';
import type { AgentProfile } from '../../profiles/profile.js';

const DECLARED_TOOLS = ['files_query', 'analyze_image'];

function makeProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test',
    name: 'Test',
    access: { level: 'internal', rich_output: false },
    model: { id: 'flash', provider: 'openai-compatible' },
    tools: DECLARED_TOOLS,
    system_prompt: 'test',
    ...overrides,
  } as AgentProfile;
}

describe('resolveEffectiveTools — profile narrowing', () => {
  it('custom profile keeps its declared tools, plus the built-ins every Agent has', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({
        id: 'custom:abc',
        access: { level: 'internal', rich_output: true },
      }),
      profileId: 'custom:abc',
    });
    expect([...result.effectiveTools].sort()).toEqual(
      [...new Set([...DECLARED_TOOLS, ...BUILTIN_AGENT_TOOL_IDS])].sort(),
    );
  });

  it('custom profile still cannot reach a tool the author did not declare', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'custom:abc' }),
      profileId: 'custom:abc',
    });
    // Domain data and outbound channels remain the author's decision.
    for (const id of ['tables_query', 'email_mutation', 'project_query']) {
      expect(result.effectiveTools).not.toContain(id);
    }
  });

  // The "built-ins widen the filter, not the permissions" invariant needs a real
  // user allow-set to be worth anything — see builtin-tools.db.test.ts.

  it('internal profile + super user → full user allow-set', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'sprouty', access: { level: 'internal', rich_output: true } }),
      profileId: 'sprouty',
    });
    expect([...result.effectiveTools].sort()).toEqual([...getAllToolIds()].sort());
  });

  it('does not expose the un-narrowed user tool set on the result', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'sprouty' }),
      profileId: 'sprouty',
    });
    expect(Object.keys(result)).toEqual(['effectiveTools']);
  });
});

// The lazy tools here are constructed, never executed, so a stub db is enough.
const STUB_DB = {} as DatabaseProvider;

describe('buildLazyServerTools — session-scoped orchestration tools', () => {
  it('assembles task_capture in an ordinary chat session (no profile gate)', () => {
    const tools = buildLazyServerTools(STUB_DB, ['task_capture'], {
      userId: 'u1',
      userRole: 'team',
      sessionId: 's1',
      profileId: 'sprouty',
    });
    expect(Object.keys(tools)).toContain('task_capture');
  });

  it('omits it on the stateless proxy/MCP surface (no sessionId → no confirm surface)', () => {
    const tools = buildLazyServerTools(STUB_DB, ['task_capture'], { userId: 'u1', userRole: 'team' });
    expect(Object.keys(tools)).not.toContain('task_capture');
  });

  it('omits it when the user is not allowed the tool', () => {
    const tools = buildLazyServerTools(STUB_DB, ['session_query'], {
      userId: 'u1',
      userRole: 'team',
      sessionId: 's1',
      profileId: 'sprouty',
    });
    expect(Object.keys(tools)).not.toContain('task_capture');
  });
});

/**
 * 3.0 removed the Home workbench and its `workbench_query` / `workbench_mutation`
 * tools. Saved Agents and automations may still name them; an unknown id must be
 * dropped quietly, never fail the run.
 */
describe('stored ids of removed tools', () => {
  const REMOVED = ['workbench_query', 'workbench_mutation'];

  it('a custom Agent that ticked the workbench tools still resolves, without them', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'custom:old', tools: [...REMOVED, 'files_query'] }),
      profileId: 'custom:old',
    });
    expect(result.effectiveTools).toContain('files_query');
    for (const id of REMOVED) expect(result.effectiveTools).not.toContain(id);
  });

  it('building tools for an unknown id is a no-op, not an error', () => {
    const tools = buildLazyServerTools({} as DatabaseProvider, [...REMOVED, 'memory'], {
      userId: 'u1',
      userRole: 'team',
    });
    expect(Object.keys(tools)).toEqual(LAZY_TOOL_IDS.has('memory') ? ['memory'] : []);
  });

  it('an automation opt-in list naming them normalizes them away', () => {
    expect(normalizeAutomationOptInTools([...REMOVED, 'memory'])).toEqual(
      LAZY_TOOL_IDS.has('memory') ? ['memory'] : [],
    );
  });
});

/**
 * Stored tool ids are live ids: core migrations 0001 and 0004 rewrote the
 * retired ones in custom Agents, so the resolver no longer aliases anything.
 * A stored id whose plugin is off stays dormant.
 */
describe('stored custom-Agent tool ids', () => {
  const custom = (tools: string[]) =>
    resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'custom:stored', tools }),
      profileId: 'custom:stored',
    });

  it('does not expand a retired id to a successor', async () => {
    const result = await custom(['team_knowledge', 'project_manager', 'example_notes_legacy']);
    for (const id of ['team_knowledge', 'project_manager', 'example_notes_legacy']) {
      expect(getAllToolIds()).not.toContain(id);
      expect(result.effectiveTools).not.toContain(id);
    }
    for (const id of ['knowledge_query', 'project_query', 'project_mutation', 'example_notes_query']) {
      expect(result.effectiveTools).not.toContain(id);
    }
  });

  it('keeps an unregistered (plugin off) tool id dormant', async () => {
    const result = await custom(['files_query', 'off_plugin_query']);
    expect(result.effectiveTools).toContain('files_query');
    expect(result.effectiveTools).not.toContain('off_plugin_query');
  });
});
