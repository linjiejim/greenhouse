/**
 * mission_dispatch entitlement — the `cloud-agent` feature flag is the gate.
 *
 * UI hiding is not access control, and neither is a card the user cannot use:
 * a team member with the flag off must never have the tool ASSEMBLED, so the
 * model has nothing to call and no Launch button can appear. This mirrors how
 * the CRM flag governs its chat tools (session-modes spec, Phase B).
 *
 * Since 2026-08-14 the flag is `defaultEnabled: true` (baseline capability):
 * a user with no row holds the tool; an explicit disable row takes it away.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

import { resolveUserTools } from '../../apps/api/src/agent.js';
import { buildLazyServerTools } from '../../apps/api/src/agent-runtime/tool-resolution.js';

let db: DatabaseProvider;
let user: UserRow;

function assembled(effectiveTools: string[]): string[] {
  return Object.keys(
    buildLazyServerTools(db, effectiveTools, {
      userId: user.id,
      userRole: user.role,
      sessionId: 'sess-1',
      profileId: 'sprouty-quick',
    }),
  );
}

describe('mission_dispatch feature gating', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `md-${Date.now()}-${Math.random()}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('a team user with no explicit row holds the tool (defaultEnabled baseline)', async () => {
    const { activeTools } = await resolveUserTools(user.id, user.role);
    expect(activeTools).toContain('mission_dispatch');
    expect(assembled(activeTools)).toContain('mission_dispatch');
  });

  it('an explicit disable takes it away, re-enabling grants it back', async () => {
    await db.userFeatures.upsert({ user_id: user.id, feature: 'cloud-agent', enabled: false, granted_by: user.id });
    let { activeTools } = await resolveUserTools(user.id, user.role);
    expect(activeTools).not.toContain('mission_dispatch');
    expect(assembled(activeTools)).not.toContain('mission_dispatch');

    await db.userFeatures.upsert({ user_id: user.id, feature: 'cloud-agent', enabled: true, granted_by: user.id });
    ({ activeTools } = await resolveUserTools(user.id, user.role));
    expect(activeTools).toContain('mission_dispatch');
    expect(assembled(activeTools)).toContain('mission_dispatch');
  });

  it('workflow_plan is unavailable to team users even when directly assigned', async () => {
    await db.userTools.setTools(user.id, ['workflow_plan'], user.id);
    const { activeTools } = await resolveUserTools(user.id, user.role);
    expect(activeTools).not.toContain('workflow_plan');
    expect(assembled(activeTools)).not.toContain('workflow_plan');
  });

  it('workflow_plan remains available and assembled for super users', async () => {
    user = await createInternalTestUser(db, {
      email: `workflow-super-${Date.now()}-${Math.random()}@test.local`,
      role: 'super',
    });
    const { activeTools } = await resolveUserTools(user.id, user.role);
    expect(activeTools).toContain('workflow_plan');
    expect(assembled(activeTools)).toContain('workflow_plan');
  });

  it('is not individually assignable — the feature owns it', async () => {
    const { FEATURE_OWNED_TOOL_IDS, toolsetToolIds } = await import(
      '../../apps/api/src/platform/feature-points.js'
    );
    expect(FEATURE_OWNED_TOOL_IDS.has('mission_dispatch')).toBe(true);
    expect(toolsetToolIds()).not.toContain('mission_dispatch');
    expect(toolsetToolIds()).not.toContain('workflow_plan');
  });
});
