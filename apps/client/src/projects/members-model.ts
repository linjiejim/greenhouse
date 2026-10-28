/**
 * Rules of a project's members panel (src/projects/use-project-members.ts), React-free. Who may
 * manage mirrors the station's rule (plugins/projects platform `projectAccess`: a super, the
 * project's owner or maker, or an owner-role member); the station stays the judge, and a refusal
 * (403) turns the panel read-only.
 */

import type { Project, ProjectMember } from '../shared/greenhouse-types';

export type MemberRole = ProjectMember['role'];

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'member'];

type Me = { id: string; role?: string } | null | undefined;
type Owned = Pick<Project, 'owner_id' | 'created_by'>;

export function canManageMembers(me: Me, project: Owned | null | undefined, members: readonly ProjectMember[]): boolean {
  if (!me || !project) return false;
  return (
    me.role === 'super' ||
    project.owner_id === me.id ||
    (!!project.created_by && project.created_by === me.id) ||
    members.some((member) => member.user_id === me.id && member.role === 'owner')
  );
}

/** Owners first, then by name. */
export function sortedMembers(members: readonly ProjectMember[]): ProjectMember[] {
  return [...members].sort(
    (a, b) =>
      Number(b.role === 'owner') - Number(a.role === 'owner') ||
      (a.nickname ?? a.user_id).localeCompare(b.nickname ?? b.user_id),
  );
}

/** The people who may still join: everyone offered who is not a member yet, by name. */
export function addableUsers<U extends { id: string; nickname: string }>(
  users: readonly U[],
  members: readonly ProjectMember[],
): U[] {
  const taken = new Set(members.map((member) => member.user_id));
  return users.filter((user) => !taken.has(user.id)).sort((a, b) => a.nickname.localeCompare(b.nickname));
}

/**
 * What a manager may change on one member: never their own row (they would lock themselves out);
 * the project's owner and maker cannot be removed (the station answers 409).
 */
export function memberControls(
  member: ProjectMember,
  me: Me,
  project: Owned | null | undefined,
  manage: boolean,
): { role: boolean; remove: boolean } {
  if (!manage || !me || member.user_id === me.id) return { role: false, remove: false };
  const keeps = member.user_id === project?.owner_id || (!!project?.created_by && member.user_id === project.created_by);
  return { role: true, remove: !keeps };
}
