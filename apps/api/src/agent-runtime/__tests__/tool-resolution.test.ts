/**
 * Tests for the profile↔user tool intersection boundary.
 *
 * Internal system profiles use the user's full allow-set, while custom profiles
 * can only narrow that set. The resolver must not expose a second, un-narrowed
 * result that could later leak into prompts.
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { parseWorkbenchConfig } from '@greenhouse/types/workbench';
import { resolveEffectiveTools, buildLazyServerTools, childSpawnToolIds } from '../tool-resolution.js';
import { MAX_SPAWN_DEPTH } from '../../tools/spawn-session.js';
import { BUILTIN_AGENT_TOOL_IDS, RETIRED_TOOL_ALIASES, getAllToolIds } from '../../tools/registry.js';
import type { AgentProfile } from '../../profile.js';

const DECLARED_TOOLS = ['knowledge_query', 'analyze_image'];

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
  it('assembles workflow_plan in an ordinary chat session (no profile gate)', () => {
    const tools = buildLazyServerTools(STUB_DB, ['workflow_plan'], {
      userId: 'u1',
      userRole: 'team',
      sessionId: 's1',
      profileId: 'sprouty-quick',
    });
    expect(Object.keys(tools)).toContain('workflow_plan');
  });

  it('still assembles workflow_plan for the workflows preset', () => {
    const tools = buildLazyServerTools(STUB_DB, ['workflow_plan'], {
      userId: 'u1',
      userRole: 'team',
      sessionId: 's1',
      profileId: 'sprouty-workflows',
    });
    expect(Object.keys(tools)).toContain('workflow_plan');
  });

  it('omits it on the stateless proxy/MCP surface (no sessionId → no confirm surface)', () => {
    const tools = buildLazyServerTools(STUB_DB, ['workflow_plan'], { userId: 'u1', userRole: 'team' });
    expect(Object.keys(tools)).not.toContain('workflow_plan');
  });

  it('omits it when the user is not allowed the tool', () => {
    const tools = buildLazyServerTools(STUB_DB, ['session_query'], {
      userId: 'u1',
      userRole: 'team',
      sessionId: 's1',
      profileId: 'sprouty-quick',
    });
    expect(Object.keys(tools)).not.toContain('workflow_plan');
  });

  it('assembles mission_dispatch in a session that holds it', () => {
    const tools = buildLazyServerTools(STUB_DB, ['mission_dispatch'], {
      userId: 'u1',
      userRole: 'team',
      sessionId: 's1',
      profileId: 'sprouty-quick',
    });
    expect(Object.keys(tools)).toContain('mission_dispatch');
  });

  it('omits mission_dispatch on the stateless proxy/MCP surface', () => {
    const tools = buildLazyServerTools(STUB_DB, ['mission_dispatch'], { userId: 'u1', userRole: 'team' });
    expect(Object.keys(tools)).not.toContain('mission_dispatch');
  });
});

describe('buildLazyServerTools — workbench cards can only bind what the user can read', () => {
  const DB_WITH_EMPTY_WORKBENCH = {
    platform: { getUserWorkbenchPreferences: async () => parseWorkbenchConfig({}) },
  } as unknown as DatabaseProvider;

  it('hands the workbench tools the read-only intersection, not the whole tool set', async () => {
    const tools = buildLazyServerTools(
      DB_WITH_EMPTY_WORKBENCH,
      ['workbench_query', 'workbench_mutation', 'project_query', 'project_mutation', 'memory'],
      { userId: 'u1', userRole: 'team' },
    );

    // A card is re-run as this user forever after, so binding a tool they cannot
    // call — or a WRITE tool — would be a standing request they never made.
    const execute = (tools.workbench_query as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
    const result = (await execute({ action: 'get' }, { toolCallId: 't', messages: [] })) as {
      bindable_tool_ids: string[];
    };
    expect(result.bindable_tool_ids).toEqual(['project_query']);
  });
});

describe('childSpawnToolIds — headless children fail closed to replay-safe reads', () => {
  const parentTools = ['workflow_plan', 'mission_dispatch', 'spawn_session', 'call_llm', 'knowledge_query'];

  it('strips both dispatch tools at every depth', () => {
    for (const depth of [0, 1, MAX_SPAWN_DEPTH]) {
      const ids = childSpawnToolIds(parentTools, depth);
      expect(ids, `depth ${depth}`).not.toContain('workflow_plan');
      expect(ids, `depth ${depth}`).not.toContain('mission_dispatch');
    }
  });

  it('keeps only catalogued proxy reads explicitly declared replay-safe', () => {
    expect(childSpawnToolIds(parentTools, 0)).toEqual(['knowledge_query']);
    expect(childSpawnToolIds(parentTools, MAX_SPAWN_DEPTH)).toEqual(['knowledge_query']);
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
      profile: makeProfile({ id: 'custom:retired', tools: ['team_knowledge', 'personal_knowledge'] }),
      profileId: 'custom:retired',
    });

    // An Agent whose author ticked the old names still reaches the successor…
    expect(result.effectiveTools).toContain('knowledge_query');
    // …and the retired ids themselves never reach the model.
    expect(result.effectiveTools).not.toContain('team_knowledge');
    expect(result.effectiveTools).not.toContain('personal_knowledge');
  });

  it('every alias target is a live tool id', () => {
    const live = new Set(getAllToolIds());
    for (const [retired, successors] of Object.entries(RETIRED_TOOL_ALIASES)) {
      expect(live.has(retired), `${retired} should be retired, not registered`).toBe(false);
      for (const s of successors) expect(live.has(s), `${retired} → ${s} must exist`).toBe(true);
    }
  });
});
