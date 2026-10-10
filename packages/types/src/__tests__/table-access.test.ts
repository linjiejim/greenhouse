/**
 * The effective-role decision table (`decideTableBaseAccess`) — the one order
 * the API resolver and the db automation check both use.
 */

import { describe, expect, it } from 'vitest';
import { decideTableBaseAccess, type TableBaseAccessFacts } from '../table-access.js';

const team = { id: 'u-team', role: 'team', status: 'active' };
const base: TableBaseAccessFacts['base'] = {
  owner_id: 'u-owner',
  visibility: 'private',
  team_role: 'viewer',
  team_custom_role_id: null,
  archived_at: null,
};

function decide(overrides: Partial<TableBaseAccessFacts>) {
  return decideTableBaseAccess({ user: team, base, member: undefined, ...overrides });
}

describe('decideTableBaseAccess', () => {
  it('refuses missing, inactive and non-internal users, and archived Bases', () => {
    expect(decide({ user: undefined }).level).toBe('none');
    expect(
      decide({ user: { ...team, status: 'disabled' }, member: { role: 'editor', custom_role_id: null } }).level,
    ).toBe('none');
    expect(decide({ user: { ...team, role: 'external' }, base: { ...base, visibility: 'team' } }).level).toBe('none');
    expect(
      decide({ user: { ...team, role: 'super' }, base: { ...base, archived_at: '2026-10-11T00:00:00Z' } }).level,
    ).toBe('none');
  });

  it('makes super and the owner owners without a member row', () => {
    expect(decide({ user: { ...team, role: 'super' } })).toEqual({ level: 'owner', via: 'super' });
    expect(decide({ user: { ...team, id: 'u-owner' } })).toEqual({ level: 'owner', via: 'owner' });
  });

  it('lets the own member row win over the team default, even when it is lower', () => {
    const teamEditors = { ...base, visibility: 'team' as const, team_role: 'editor' as const };
    expect(decide({ base: teamEditors, member: { role: 'viewer', custom_role_id: null } })).toEqual({
      level: 'viewer',
      via: 'member',
    });
    expect(decide({ base: teamEditors })).toEqual({ level: 'editor', via: 'team' });
  });

  it('falls back to none on a private Base without a grant', () => {
    expect(decide({})).toEqual({ level: 'none', via: 'none' });
  });

  it('carries the custom role id, and treats a dangling one as none (never viewer)', () => {
    expect(decide({ member: { role: 'custom', custom_role_id: 7 } })).toEqual({
      level: 'custom',
      via: 'member',
      customRoleId: 7,
    });
    expect(decide({ member: { role: 'custom', custom_role_id: null } }).level).toBe('none');
    const teamCustom = { ...base, visibility: 'team' as const, team_role: 'custom' as const };
    expect(decide({ base: { ...teamCustom, team_custom_role_id: 3 } })).toEqual({
      level: 'custom',
      via: 'team',
      customRoleId: 3,
    });
    expect(decide({ base: teamCustom }).level).toBe('none');
  });
});
