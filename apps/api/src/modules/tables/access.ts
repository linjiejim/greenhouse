/**
 * Who may do what in a base, for every route (data-model.md §1, §6):
 * - its owner (`bases.owner_id`) is an owner;
 * - everyone else only what `shares` (resource `base`) give them: as a member, through a group,
 *   or the whole workspace; the best of these counts. Groups and the workspace edit or view only;
 * - a share may give a custom role (`role` custom, `custom_role_id` a base_roles row): per data
 *   table it is seen or not, read or edited, with only some records and without some fields.
 *   Any of the four roles beats custom roles; several custom roles add up;
 * - all of it only while the member's tables module is on. Admins get nothing extra.
 * Roles: owner (share, archive, delete), builder (tables, fields, shared views), editor
 * (records), viewer (read, comment, personal views).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { BASE_ROLES, roleAtLeast, roleRulesSchema, type BaseRole, type Filter } from '@greenhouse/contract';
import { baseRoles, bases, getDb, groupMembers, members, shares, type BaseRow } from '@greenhouse/db';
import { ApiError, forbidden, notFound } from '../../http/errors.js';
import { principalMatch } from '../knowledge/access.js';
import { effectiveModules } from '../members/service.js';

export interface TablesReader {
  memberId: string;
  name: string;
  locale: 'zh' | 'en';
  timeZone: string;
  groupIds: string[];
}

/** What a custom role lets the reader do in one data table. */
export interface CustomTableRules {
  access: 'read' | 'edit';
  /** The records seen: any of these filters (`$me` is the reader); none: every record. */
  rows: Filter[];
  /** Fields not seen (computed fields that read them are hidden too, see scope.ts). */
  hidden: ReadonlySet<string>;
  /** Additional restrictions, intersected with the role's rows (application runtime). */
  constraints?: Filter[];
  /** Each group allows any of its filters; the groups intersect. */
  rowGroups?: Filter[][];
  /** Card columns are a projection, not an extra permission rule on computed dependencies. */
  presentation?: ReadonlySet<string>;
}

/** The reader's custom roles in a base, added up; tables not in `tables` are not seen. */
export interface CustomAccess {
  roles: Array<{ id: string; name: string }>;
  tables: ReadonlyMap<string, CustomTableRules>;
}

export interface BaseAccess {
  /** For a custom role: editor when it edits some table, else viewer. */
  role: BaseRole;
  custom: CustomAccess | null;
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

/** Custom roles added up: a table any of them sees, edited if any edits it, rows any of them sees, fields all of them hide. */
export function combineRoles(rows: Array<{ id: string; name: string; rules: unknown }>): CustomAccess {
  const tables = new Map<string, { access: 'read' | 'edit'; rows: Filter[] | null; hidden: Set<string> | null }>();
  for (const role of rows) {
    const parsed = roleRulesSchema.safeParse(role.rules);
    // A role whose rules cannot be read grants nothing.
    if (!parsed.success) continue;
    for (const [tableId, rules] of Object.entries(parsed.data.tables)) {
      if (rules.access === 'none') continue;
      const now = tables.get(tableId);
      const hidden = new Set(rules.hidden_fields ?? []);
      const filter = rules.rows && rules.rows.clauses.length ? rules.rows : null;
      if (!now) {
        tables.set(tableId, { access: rules.access, rows: filter ? [filter] : null, hidden });
        continue;
      }
      if (rules.access === 'edit') now.access = 'edit';
      // null means every record: once one role sees them all, the reader does.
      now.rows = now.rows && filter ? [...now.rows, filter] : null;
      now.hidden = new Set([...(now.hidden ?? [])].filter((id) => hidden.has(id)));
    }
  }
  return {
    roles: rows.map((row) => ({ id: row.id, name: row.name })),
    tables: new Map(
      [...tables].map(([id, entry]) => [
        id,
        { access: entry.access, rows: entry.rows ?? [], hidden: entry.hidden ?? new Set() },
      ]),
    ),
  };
}

/** The reader's access to each of these bases (missing: none). */
async function baseAccessOn(
  reader: TablesReader,
  rows: readonly Pick<BaseRow, 'id' | 'ownerId'>[],
): Promise<Map<string, BaseAccess>> {
  const access = new Map<string, BaseAccess>();
  const others = rows.filter((row) => {
    if (row.ownerId !== reader.memberId) return true;
    access.set(row.id, { role: 'owner', custom: null });
    return false;
  });
  if (!others.length) return access;
  const granted = await getDb()
    .select({ id: shares.resourceId, role: shares.role, customRoleId: shares.customRoleId })
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
  const standard = new Map<string, BaseRole>();
  const customIds = new Map<string, Set<string>>();
  for (const row of granted) {
    if (row.role === 'custom') {
      if (!row.customRoleId) continue;
      const ids = customIds.get(row.id) ?? new Set<string>();
      ids.add(row.customRoleId);
      customIds.set(row.id, ids);
      continue;
    }
    const role = bestRole(standard.get(row.id), asRole(row.role));
    if (role) standard.set(row.id, role);
  }
  for (const [baseId, role] of standard) access.set(baseId, { role, custom: null });
  const pending = [...customIds].filter(([baseId]) => !standard.has(baseId));
  if (pending.length) {
    const roleRows = await getDb()
      .select({ id: baseRoles.id, baseId: baseRoles.baseId, name: baseRoles.name, rules: baseRoles.rules })
      .from(baseRoles)
      .where(
        inArray(
          baseRoles.id,
          pending.flatMap(([, ids]) => [...ids]),
        ),
      );
    for (const [baseId, ids] of pending) {
      // A role of another base (a stale share) grants nothing.
      const mine = roleRows.filter((row) => row.baseId === baseId && ids.has(row.id));
      if (!mine.length) continue;
      const custom = combineRoles(mine);
      const edits = [...custom.tables.values()].some((rules) => rules.access === 'edit');
      access.set(baseId, { role: edits ? 'editor' : 'viewer', custom });
    }
  }
  return access;
}

/** Applications narrow the existing access compiler for the lifetime of one request. */
const restrictions = new AsyncLocalStorage<{ baseId: string; rules: CustomAccess | null }>();
export function withBaseRestriction<T>(baseId: string, rules: CustomAccess | null, work: () => Promise<T>): Promise<T> {
  return restrictions.run({ baseId, rules }, work);
}

export async function accessOn(
  reader: TablesReader,
  rows: readonly Pick<BaseRow, 'id' | 'ownerId'>[],
): Promise<Map<string, BaseAccess>> {
  const access = await baseAccessOn(reader, rows);
  const limit = restrictions.getStore();
  if (!limit) return access;
  for (const [id, original] of access) {
    if (id !== limit.baseId) {
      access.delete(id);
      continue;
    }
    if (!limit.rules) continue;
    const tables = new Map<string, CustomTableRules>();
    for (const [tableId, rule] of limit.rules.tables) {
      const own = original.custom?.tables.get(tableId);
      if (original.custom && !own) continue;
      tables.set(tableId, {
        access: original.role === 'viewer' || own?.access === 'read' || rule.access === 'read' ? 'read' : 'edit',
        rows: own?.rows ?? [],
        hidden: new Set([...(own?.hidden ?? []), ...rule.hidden]),
        constraints: [...(own?.constraints ?? []), ...(rule.constraints ?? [])],
        presentation: rule.presentation,
        rowGroups: [...(own?.rowGroups ?? []), ...(rule.rows.length ? [rule.rows] : []), ...(rule.rowGroups ?? [])],
      });
    }
    access.set(id, {
      role: [...tables.values()].some((t) => t.access === 'edit') ? 'editor' : 'viewer',
      custom: { roles: limit.rules.roles, tables },
    });
  }
  return access;
}

/** Live bases the reader sees only through custom roles, with what the roles allow. */
export async function customBasesOf(reader: TablesReader): Promise<Map<string, CustomAccess>> {
  const candidates = await getDb()
    .selectDistinct({ id: bases.id, ownerId: bases.ownerId })
    .from(bases)
    .innerJoin(
      shares,
      and(
        eq(shares.resourceType, 'base'),
        eq(shares.resourceId, bases.id),
        eq(shares.role, 'custom'),
        principalMatch(reader),
      ),
    )
    .where(isNull(bases.archivedAt));
  const out = new Map<string, CustomAccess>();
  if (!candidates.length) return out;
  for (const [id, entry] of await accessOn(reader, candidates)) if (entry.custom) out.set(id, entry.custom);
  return out;
}

/** The reader's role on each of these bases (missing: none); a custom role reads as editor or viewer. */
export async function rolesOn(reader: TablesReader, rows: readonly Pick<BaseRow, 'id' | 'ownerId'>[]) {
  const roles = new Map<string, BaseRole>();
  for (const [id, entry] of await accessOn(reader, rows)) roles.set(id, entry.role);
  return roles;
}

/**
 * A base with the reader's access to it, at least `needed`. No access at all is not found (its
 * existence stays private); too little access is forbidden, with the reason. `standard` refuses
 * custom roles (the recycle bin, which spans every table).
 */
export async function baseAt(
  reader: TablesReader,
  baseId: string,
  needed: BaseRole,
  options: { archived?: boolean; standard?: boolean } = {},
): Promise<{ base: BaseRow; role: BaseRole; custom: CustomAccess | null }> {
  const [base] = await getDb().select().from(bases).where(eq(bases.id, baseId));
  if (!base) throw notFound('Base');
  const access = (await accessOn(reader, [base])).get(base.id) ?? null;
  if (!access) throw notFound('Base');
  // An archived base is its owners' to restore or delete; for everyone else it is gone.
  if (base.archivedAt && !(options.archived && roleAtLeast(access.role, 'owner'))) throw notFound('Base');
  if (!roleAtLeast(access.role, needed)) throw forbidden(NEEDS[needed]);
  if (options.standard && access.custom) throw forbidden('Your role in this base does not include this.');
  return { base, role: access.role, custom: access.custom };
}

const NEEDS: Record<BaseRole, string> = {
  viewer: 'You cannot see this base.',
  editor: 'You can view this base but not change its records.',
  builder: 'Only its builders change the tables, fields and shared views of this base.',
  owner: 'Only its owners share, archive or delete this base.',
};

export const needsRole = (role: BaseRole) => forbidden(NEEDS[role]);

/** A base-level not found answered as the thing asked for, so the answer says nothing about the base. */
export async function asNotFound<T>(kind: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw notFound(kind);
    throw error;
  }
}

export interface Audience {
  /** Everyone who may see the base now. */
  ids: string[];
  /** Those of them who see it only through a custom role (told less: see service.ts). */
  limited: ReadonlySet<string>;
}

/**
 * Members who may see a base now: its owner, members and groups it is shared with, or everyone;
 * only active members whose tables module is on.
 */
export async function audienceOf(base: Pick<BaseRow, 'id' | 'ownerId'>): Promise<Audience> {
  const rows = await getDb()
    .select({ type: shares.principalType, id: shares.principalId, role: shares.role })
    .from(shares)
    .where(and(eq(shares.resourceType, 'base'), eq(shares.resourceId, base.id)));
  const standard = new Set<string>([base.ownerId]);
  const custom = new Set<string>();
  const into = (role: string) => (role === 'custom' ? custom : standard);
  const everyone = rows.filter((row) => row.type === 'workspace');
  const groupIds = rows.filter((row) => row.type === 'group' && row.id);
  for (const row of rows) if (row.type === 'member' && row.id) into(row.role).add(row.id);
  if (groupIds.length) {
    const inGroups = await getDb()
      .select({ id: groupMembers.memberId, group: groupMembers.groupId })
      .from(groupMembers)
      .where(
        inArray(
          groupMembers.groupId,
          groupIds.map((row) => row.id!),
        ),
      );
    const roleOf = new Map(groupIds.map((row) => [row.id!, row.role]));
    for (const row of inGroups) into(roleOf.get(row.group) ?? 'viewer').add(row.id);
  }
  // Active members with tables on; all of them when the base is shared with everyone.
  const active = await getDb()
    .select({ id: members.id, modules: members.modules })
    .from(members)
    .where(
      and(eq(members.status, 'active'), everyone.length ? undefined : inArray(members.id, [...standard, ...custom])),
    );
  const allowed = new Set(active.filter((row) => effectiveModules(row.modules).tables).map((row) => row.id));
  for (const row of everyone) for (const id of allowed) into(row.role).add(id);
  const ids = [...new Set([...standard, ...custom])].filter((id) => allowed.has(id));
  return { ids, limited: new Set(ids.filter((id) => custom.has(id) && !standard.has(id))) };
}

/** Whether a member may read a base now (for notifications). */
export async function canRead(memberId: string, baseId: string): Promise<boolean> {
  const reader = await loadReader(memberId).catch(() => null);
  if (!reader) return false;
  const [base] = await getDb()
    .select()
    .from(bases)
    .where(and(eq(bases.id, baseId), isNull(bases.archivedAt)));
  if (!base) return false;
  return (await accessOn(reader, [base])).has(base.id);
}
