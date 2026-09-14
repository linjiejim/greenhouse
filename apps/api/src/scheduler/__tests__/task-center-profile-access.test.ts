/**
 * Profile-access gate for scheduled tasks (checkProfileAccess in task-center.ts,
 * shared by the HTTP routes and the automation_mutation tool).
 *
 * Regression for "Profile "team" is not assigned to your account": the gate
 * used to require team members to have a user_profiles assignment row, but
 * internal users get profiles by role (same rule as chat's access check).
 *
 * Uses the real profile YAMLs (team=internal, desktop=hidden integration). The
 * removed `default` ID remains a compatibility alias for `team`. No
 * separate hidden-only stub pins the generic hidden-profile rule too.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../profiles/profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../profiles/profile.js')>();
  return {
    ...actual,
    resolveProfileAsync: async (id?: string | null) => {
      if (id === 'hidden-only') {
        const base = actual.resolveProfile('team');
        return { ...base, id, access: { ...base.access, level: 'hidden' as const } };
      }
      return actual.resolveProfileAsync(id);
    },
  };
});

import { checkProfileAccess } from '../task-center.js';

describe('scheduled tasks — checkProfileAccess', () => {
  it('allows a team member on the internal "team" profile (regression)', async () => {
    await expect(checkProfileAccess('team')).resolves.toBeNull();
  });

  it('allows the legacy default alias and other internal profiles', async () => {
    await expect(checkProfileAccess('default')).resolves.toBeNull();
    await expect(checkProfileAccess('eval-judge')).resolves.toBeNull();
  });

  it('allows interactive profiles but not hidden integrations', async () => {
    await expect(checkProfileAccess('team')).resolves.toBeNull();
    await expect(checkProfileAccess('hidden-only')).resolves.toMatch(/not available/);
  });

  it('rejects the hidden compatibility runtime for everyone', async () => {
    await expect(checkProfileAccess('desktop')).resolves.toMatch(/not available/);
  });

  it('rejects hidden profiles', async () => {
    await expect(checkProfileAccess('hidden-only')).resolves.toMatch(/not available/);
  });
});
