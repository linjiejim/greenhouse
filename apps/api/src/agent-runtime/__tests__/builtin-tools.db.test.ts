/**
 * Built-in Agent tools widen the PROFILE FILTER, never the user's permissions.
 *
 * A custom Agent's `tools` array is an intersection filter, and the built-ins
 * join that filter so an author who never ticked "scheduling" still gets an
 * Agent that can schedule. Written the other way round — unioned into the
 * result — the same feature would hand every author tools their account does
 * not carry, silently, on every custom Agent at once.
 *
 * That distinction is invisible with a super user (who holds everything), so it
 * is asserted here against a real team allow-set with a feature flag turned off.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { resolveEffectiveTools } from '../tool-resolution.js';
import { resolveUserTools } from '../../agent.js';
import { BUILTIN_AGENT_TOOL_IDS } from '../../tools/registry.js';
import type { AgentProfile } from '../../profile.js';

let db: DatabaseProvider;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

/** A custom Agent whose author declared exactly one tool. */
function soleDeclaredTool(): AgentProfile {
  return {
    id: 'custom:1',
    name: 'Narrow Agent',
    access: { level: 'internal', rich_output: false },
    model: { id: 'flash', provider: 'deepseek' },
    tools: ['knowledge_query'],
    system_prompt: 'test',
  } as AgentProfile;
}

describe('built-in tools against a real team allow-set', () => {
  it('grants the built-ins the user holds, without the author declaring them', async () => {
    const user = await createInternalTestUser(db, { email: `builtin-${Date.now()}@example.com` });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: user.id,
      userRole: 'team',
      profile: soleDeclaredTool(),
      profileId: 'custom:1',
    });

    // The friction this fixes: an Agent whose author only ticked one thing
    // could not ask a question, read an attachment or schedule anything.
    expect(effectiveTools).toContain('knowledge_query');
    expect(effectiveTools).toContain('ask_user');
    expect(effectiveTools).toContain('read_attachment');
    expect(effectiveTools).toContain('automation_mutation');
  });

  it('withholds a built-in whose feature flag the user does not have', async () => {
    const user = await createInternalTestUser(db, { email: `builtin-off-${Date.now()}@example.com` });
    // `memory` is a built-in, but it is owned by a feature flag rather than
    // being global. Turning the flag off must still remove it.
    await db.userFeatures.upsert({ user_id: user.id, feature: 'memory', enabled: false });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: user.id,
      userRole: 'team',
      profile: soleDeclaredTool(),
      profileId: 'custom:1',
    });

    expect(BUILTIN_AGENT_TOOL_IDS.has('memory')).toBe(true);
    expect(effectiveTools).not.toContain('memory');
  });

  it('returns nothing outside the user allow-set, built-in or not', async () => {
    const user = await createInternalTestUser(db, { email: `builtin-scope-${Date.now()}@example.com` });

    const { effectiveTools } = await resolveEffectiveTools({
      userId: user.id,
      userRole: 'team',
      profile: soleDeclaredTool(),
      profileId: 'custom:1',
    });

    // Whatever the filter says, the intersection with the caller's own tools is
    // what makes "a profile can only narrow" true.
    const { allowedTools } = await resolveUserTools(user.id, 'team');
    for (const id of effectiveTools) expect(allowedTools).toContain(id);
  });
});
