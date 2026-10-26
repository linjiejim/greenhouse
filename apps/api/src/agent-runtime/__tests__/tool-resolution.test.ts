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
import { BUILTIN_AGENT_TOOL_IDS, RETIRED_TOOL_ALIASES, getAllToolIds } from '../../tools/registry.js';
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
      profile: makeProfile({ id: 'team', access: { level: 'internal', rich_output: true } }),
      profileId: 'team',
    });
    expect([...result.effectiveTools].sort()).toEqual([...getAllToolIds()].sort());
  });

  it('does not expose the un-narrowed user tool set on the result', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'team' }),
      profileId: 'team',
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
      profileId: 'sprouty-quick',
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
      profileId: 'sprouty-quick',
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
 * Retired tool ids must stay meaningful, because custom profiles persist their
 * `tools` array in the DB: a retirement that forgets the alias silently narrows
 * every Agent whose author had ticked the old name.
 */
describe('RETIRED_TOOL_ALIASES expansion', () => {
  it('expands a retired id to its successor when filtering a custom profile', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'custom:retired', tools: ['session_history'] }),
      profileId: 'custom:retired',
    });

    // An Agent whose author ticked the old names still reaches the successor…
    expect(result.effectiveTools).toContain('session_query');
    // …and the retired ids themselves never reach the model.
    expect(result.effectiveTools).not.toContain('session_history');
  });

  it('every alias target is a live tool id', () => {
    const live = new Set(getAllToolIds());
    for (const [retired, successors] of Object.entries(RETIRED_TOOL_ALIASES)) {
      expect(live.has(retired), `${retired} should be retired, not registered`).toBe(false);
      for (const s of successors) expect(live.has(s), `${retired} → ${s} must exist`).toBe(true);
    }
  });
});
