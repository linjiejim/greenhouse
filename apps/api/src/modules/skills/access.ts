/**
 * Who sees a skill, in one place: the skills service lists and loads with it, and the file
 * service asks it before it serves a package's ZIP to anyone but its uploader.
 *
 * A personal skill is its owner's alone. A team skill is everyone's once its scan is clean;
 * until then (pending, suspicious) and once blocked, only its owner and admins see it.
 */

import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { getDb, members, skills, skillVersions, type MemberRole } from '@greenhouse/db';

export interface SkillActor {
  id: string;
  role: MemberRole;
}

export function visibleTo(actor: SkillActor): SQL {
  return or(
    and(eq(skills.space, 'personal'), eq(skills.ownerId, actor.id)),
    and(
      eq(skills.space, 'team'),
      actor.role === 'admin' ? undefined : or(eq(skills.scanStatus, 'clean'), eq(skills.ownerId, actor.id)),
    ),
  )!;
}

/** May this member read the package ZIP held in this file: is it a version of a skill they see? */
export async function bundleReadable(memberId: string, fileId: string): Promise<boolean> {
  const [member] = await getDb()
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(eq(members.id, memberId));
  if (!member) return false;
  const [row] = await getDb()
    .select({ one: sql`1` })
    .from(skillVersions)
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .where(and(eq(skillVersions.bundleFileId, fileId), visibleTo(member)))
    .limit(1);
  return !!row;
}

/** Whether a file holds a version of a skill: versions are immutable, so it stays. */
export async function bundleHeld(fileId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(eq(skillVersions.bundleFileId, fileId))
    .limit(1);
  return !!row;
}
