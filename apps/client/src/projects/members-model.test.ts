import { describe, expect, it } from 'vitest';
import { addableUsers, canManageMembers, memberControls, sortedMembers } from './members-model';
import type { ProjectMember } from '../shared/greenhouse-types';

const member = (user_id: string, role: ProjectMember['role'], nickname: string | null = user_id): ProjectMember => ({
  id: `pm_${user_id}`,
  project_id: 'prj_1',
  user_id,
  role,
  nickname,
});
const project = { owner_id: 'usr_owner', created_by: 'usr_maker' };
const owner = member('usr_owner', 'owner', 'Olga');
const lead = member('usr_lead', 'owner', 'Lee');
const ann = member('usr_ann', 'member', 'Ann');
const members = [owner, lead, ann];

describe('project members panel', () => {
  it('lets the people the station lets manage', () => {
    expect(canManageMembers({ id: 'usr_x', role: 'super' }, project, members)).toBe(true);
    expect(canManageMembers({ id: 'usr_owner', role: 'team' }, project, [])).toBe(true);
    expect(canManageMembers({ id: 'usr_maker', role: 'team' }, project, [])).toBe(true);
    expect(canManageMembers({ id: 'usr_lead', role: 'team' }, project, members)).toBe(true);
    expect(canManageMembers({ id: 'usr_ann', role: 'team' }, project, members)).toBe(false);
    expect(canManageMembers({ id: 'usr_ann', role: 'team' }, { owner_id: 'usr_owner', created_by: null }, [])).toBe(false);
    expect(canManageMembers(null, project, members)).toBe(false);
    expect(canManageMembers({ id: 'usr_owner' }, null, members)).toBe(false);
  });

  it('lists owners first, then by name', () => {
    expect(sortedMembers(members).map((m) => m.nickname)).toEqual(['Lee', 'Olga', 'Ann']);
    const unnamed = [member('usr_b', 'member', null), member('usr_a', 'member', null)];
    expect(sortedMembers(unnamed).map((m) => m.user_id)).toEqual(['usr_a', 'usr_b']);
  });

  it('offers only people who are not members yet', () => {
    const users = [
      { id: 'usr_zed', nickname: 'Zed' },
      { id: 'usr_ann', nickname: 'Ann' },
      { id: 'usr_bo', nickname: 'Bo' },
    ];
    expect(addableUsers(users, members).map((u) => u.id)).toEqual(['usr_bo', 'usr_zed']);
  });

  it('never changes my own row and keeps the owner and the maker', () => {
    const me = { id: 'usr_lead', role: 'team' };
    expect(memberControls(lead, me, project, true)).toEqual({ role: false, remove: false });
    expect(memberControls(owner, me, project, true)).toEqual({ role: true, remove: false });
    expect(memberControls(member('usr_maker', 'member'), me, project, true)).toEqual({ role: true, remove: false });
    expect(memberControls(ann, me, project, true)).toEqual({ role: true, remove: true });
    expect(memberControls(ann, me, project, false)).toEqual({ role: false, remove: false });
  });
});
