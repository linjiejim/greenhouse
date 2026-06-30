/**
 * Tests for the profile↔user tool intersection boundary.
 *
 * Regression guard for the public-profile tool-name leak: a super user chatting
 * on a public profile must get ONLY the profile-declared tools — and the
 * resolver must not hand back the user's full un-narrowed allow-set at all
 * (it once flowed into the system prompt and leaked internal tool names).
 */

import { describe, it, expect } from 'vitest';
import { resolveEffectiveTools } from '../tool-resolution.js';
import { getAllToolIds } from '../../tools/registry.js';
import type { AgentProfile } from '../../profile.js';

const PUBLIC_PROFILE_TOOLS = ['knowledge_query', 'analyze_image', 'ask_user'];

function makeProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'test',
    name: 'Test',
    access: { level: 'public', requires_session: false, rich_output: false },
    model: { id: 'flash', provider: 'openai-compatible' },
    tools: PUBLIC_PROFILE_TOOLS,
    system_prompt: 'test',
    ...overrides,
  } as AgentProfile;
}

describe('resolveEffectiveTools — profile narrowing', () => {
  it('public profile + super user → only the profile-declared tools', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'default' }),
      profileId: 'default',
    });
    expect([...result.effectiveTools].sort()).toEqual([...PUBLIC_PROFILE_TOOLS].sort());
    // Internal tools a super user is allowed elsewhere must NOT appear here.
    for (const internal of ['email_mutation', 'knowledge_mutation', 'project_mutation']) {
      expect(result.effectiveTools).not.toContain(internal);
    }
  });

  it('custom profile narrows the same way (profile can only narrow, never widen)', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({
        id: 'custom:abc',
        access: { level: 'internal', requires_session: true, rich_output: true },
      }),
      profileId: 'custom:abc',
    });
    expect([...result.effectiveTools].sort()).toEqual([...PUBLIC_PROFILE_TOOLS].sort());
  });

  it('internal profile + super user → full user allow-set', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'team', access: { level: 'internal', requires_session: true, rich_output: true } }),
      profileId: 'team',
    });
    expect([...result.effectiveTools].sort()).toEqual([...getAllToolIds()].sort());
  });

  it('does not expose the un-narrowed user tool set on the result', async () => {
    const result = await resolveEffectiveTools({
      userId: 'u-super',
      userRole: 'super',
      profile: makeProfile({ id: 'default' }),
      profileId: 'default',
    });
    expect(Object.keys(result)).toEqual(['effectiveTools']);
  });
});
