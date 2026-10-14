/**
 * Who may do what in a base, for every route (data-model.md §1, §6):
 * - its owner (`bases.owner_id`) is an owner;
 * - everyone else only what `shares` (resource `base`) give them: as a member, through a group,
 *   or the whole workspace; the best of these counts. Groups and the workspace edit or view only;
 * - all of it only while the member's tables module is on. Admins get nothing extra.
 * Roles: owner (share, archive, delete), builder (tables, fields, shared views), editor
 * (records), viewer (read, comment, personal views).
 */

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { BASE_ROLES, roleAtLeast, type BaseRole } from '@greenhouse/contract';
import { bases, getDb, groupMembers, members, shares, type BaseRow } from '@greenhouse/db';
import { forbidden, notFound } from '../../http/errors.js';
import { principalMatch } from '../knowledge/access.js';
import { effectiveModules } from '../members/service.js';

export interface TablesReader {
  memberId: string;
  name: string;
  locale: 'zh' | 'en';
  timeZone: string;
  groupIds: string[];
}

const RANK: Record<BaseRole, number> = { viewer: 1, editor: 2, builder: 3, owner: 4 };

export const bestRole = (a: BaseRole | null | undefined, b: BaseRole | null | undefined): BaseRole | null =>
  !a ? (b ?? null) : !b ? a : RANK[a] >= RANK[b] ? a : b;

const asRole = (role: string): BaseRole | null =>
  (BASE_ROLES as readonly string[]).includes(role) ? (role as BaseRole) : null;

/** The member as tables sees them; refused when their tables module is off. */
export async function loadReader(memberId: string): Promise<TablesReader> {
  const [member] = await getDb()
    .select({ name: members.name, locale: members.locale, timezone: members.timezone, modules: members.modules })
    .from(members)
    .where(eq(members.id, memberId));
  if (!member || !effectiveModules(member.modules).tables) throw forbidden('Tables are turned off for you.');
  const groupIds = (
    await getDb().select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.memberId, memberId))
  ).map((row) => row.id);
  return {
    memberId,
    name: member.name,
    locale: member.locale === 'en' ? 'en' : 'zh',
    timeZone: member.timezone || 'Asia/Shanghai',
    groupIds,
  };
}

/** Bases the reader may open: their own, or shared with them. */
export function readableBases(reader: TablesReader): SQL {
  return or(
    eq(bases.ownerId, reader.memberId),
    sql`EXISTS (SELECT 1 FROM ${shares} WHERE ${shares.resourceType} = 'base' AND ${shares.resourceId} = ${bases.id} AND ${principalMatch(reader)})`,
  )!;
}

/** The reader's role on each of these bases (missing: none). */
export async function rolesOn(reader: TablesReader, rows: readonly Pick<BaseRow, 'id' | 'ownerId'>[]) {
  const roles = new Map<string, BaseRole>();
  const others = rows.filter((row) => {
    if (row.ownerId !== reader.memberId) return true;
    roles.set(row.id, 'owner');
    return false;
  });
  if (others.length) {
    const granted = await getDb()
      .select({ id: shares.resourceId, role: shares.role })
      .from(shares)
      .where(
        and(
          eq(shares.resourceType, 'base'),
          inArray(
            shares.resourceId,
            others.map((row) => row.id),
          ),
          principalMatch(reader),
        ),
      );
    for (const row of granted) {
      const role = bestRole(roles.get(row.id), asRole(row.role));
      if (role) roles.set(row.id, role);
    }
  }
  return roles;
}

/**
 * A base with the reader's role on it, at least `needed`. No access at all is not found (its
 * existence stays private); too little access is forbidden, with the reason.
 */
export async function baseAt(
  reader: TablesReader,
  baseId: string,
  needed: BaseRole,
  options: { archived?: boolean } = {},
): Promise<{ base: BaseRow; role: BaseRole }> {
  const [base] = await getDb().select().from(bases).where(eq(bases.id, baseId));
  if (!base) throw notFound('Base');
  const role = (await rolesOn(reader, [base])).get(base.id) ?? null;
  if (!role) throw notFound('Base');
  // An archived base is its owners' to restore or delete; for everyone else it is gone.
  if (base.archivedAt && !(options.archived && roleAtLeast(role, 'owner'))) throw notFound('Base');
  if (!roleAtLeast(role, needed)) throw forbidden(NEEDS[needed]);
  return { base, role };
}

const NEEDS: Record<BaseRole, string> = {
  viewer: 'You cannot see this base.',
  editor: 'You can view this base but not change its records.',
  builder: 'Only its builders change the tables, fields and shared views of this base.',
  owner: 'Only its owners share, archive or delete this base.',
};

export const needsRole = (role: BaseRole) => forbidden(NEEDS[role]);

/** Members who may see a base now: its owner, members and groups it is shared with, or everyone. */
export async function audienceOf(base: Pick<BaseRow, 'id' | 'ownerId'>): Promise<string[]> {
  const rows = await getDb()
    .select({ type: shares.principalType, id: shares.principalId })
    .from(shares)
    .where(and(eq(shares.resourceType, 'base'), eq(shares.resourceId, base.id)));
  if (rows.some((row) => row.type === 'workspace')) {
    const everyone = await getDb()
      .select({ id: members.id })
      .from(members)
      .where(eq(members.status, 'active'))
      .limit(5000);
    return everyone.map((row) => row.id);
  }
  const ids = new Set([base.ownerId]);
  for (const row of rows) if (row.type === 'member' && row.id) ids.add(row.id);
  const groupIds = rows.filter((row) => row.type === 'group' && row.id).map((row) => row.id!);
  if (groupIds.length) {
    const inGroups = await getDb()
      .select({ id: groupMembers.memberId })
      .from(groupMembers)
      .where(inArray(groupMembers.groupId, groupIds));
    for (const row of inGroups) ids.add(row.id);
  }
  return [...ids];
}

/** Whether a member may read a base now (for files and notifications). */
export async function canRead(memberId: string, baseId: string): Promise<boolean> {
  const reader = await loadReader(memberId).catch(() => null);
  if (!reader) return false;
  const [base] = await getDb()
    .select()
    .from(bases)
    .where(and(eq(bases.id, baseId), isNull(bases.archivedAt)));
  if (!base) return false;
  return (await rolesOn(reader, [base])).has(base.id);
}
