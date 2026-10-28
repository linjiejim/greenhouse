/**
 * Profile-access gate for scheduled tasks (checkProfileAccess in task-center.ts,
 * shared by the HTTP routes and the automation_mutation tool). It receives the
 * pinned, canonical id (pinProfileIdForUser maps request input first).
 *
 * Regression for "Profile "team" is not assigned to your account": internal
 * users get profiles by role (same rule as chat's access check), with no
 * user_profiles assignment row.
 *
 * Uses the real profile YAMLs (sprouty=internal, desktop=hidden integration);
 * a hidden-only stub pins the generic hidden-profile rule too.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../profiles/profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../profiles/profile.js')>();
  return {
    ...actual,
    resolveProfileAsync: async (id?: string | null) => {
      if (id === 'hidden-only') {
        const base = actual.resolveProfile('sprouty');
        return { ...base, id, access: { ...base.access, level: 'hidden' as const } };
      }
      return actual.resolveProfileAsync(id);
    },
  };
});

import { checkProfileAccess } from '../task-center.js';

describe('scheduled tasks — checkProfileAccess', () => {
  it('allows a team member on the internal default profile (regression)', async () => {
    await expect(checkProfileAccess('sprouty')).resolves.toBeNull();
  });

  it('does not accept a retired id: callers pass the pinned canonical id', async () => {
    await expect(checkProfileAccess('team')).rejects.toThrow(/Profile not found/);
    await expect(checkProfileAccess('eval-judge')).rejects.toThrow(/Profile not found/);
  });

  it('rejects the hidden compatibility runtime for everyone', async () => {
    await expect(checkProfileAccess('desktop')).resolves.toMatch(/not available/);
  });

  it('rejects hidden profiles', async () => {
    await expect(checkProfileAccess('hidden-only')).resolves.toMatch(/not available/);
  });
});
