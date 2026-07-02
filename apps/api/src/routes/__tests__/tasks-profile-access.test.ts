/**
 * Profile-access gate for scheduled tasks (checkProfileAccess in tasks.ts).
 *
 * Regression for "Profile "team" is not assigned to your account": the gate
 * used to require team members to have a user_profiles assignment row, but
 * that table only applies to external users — internal members get profiles
 * by role (same rule as chat's checkCloudProfileAccess).
 *
 * Uses the real profiles (team=internal, default=public). No hidden profile
 * ships in the repo, so that branch is covered via a stubbed profile id.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '../../auth/token.js';

vi.mock('../../profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../profile.js')>();
  return {
    ...actual,
    resolveProfile: (id?: string | null) => {
      if (id === 'hidden-only') {
        const base = actual.resolveProfile('team');
        return { ...base, id, access: { ...base.access, level: 'hidden' as const } };
      }
      return actual.resolveProfile(id);
    },
  };
});

import { checkProfileAccess } from '../tasks.js';

const teamUser: AuthUser = { id: 'u-team', role: 'team' };
const superUser: AuthUser = { id: 'u-super', role: 'super' };

describe('scheduled tasks — checkProfileAccess', () => {
  it('allows a team member on the internal "team" profile (regression)', () => {
    expect(checkProfileAccess(teamUser, 'team')).toBeNull();
  });

  it('allows a team member on public profiles', () => {
    expect(checkProfileAccess(teamUser, 'default')).toBeNull();
  });

  it('allows super on any profile, including hidden', () => {
    expect(checkProfileAccess(superUser, 'team')).toBeNull();
    expect(checkProfileAccess(superUser, 'hidden-only')).toBeNull();
  });

  it('rejects hidden profiles for non-super users', () => {
    expect(checkProfileAccess(teamUser, 'hidden-only')).toMatch(/not available/);
  });
});
