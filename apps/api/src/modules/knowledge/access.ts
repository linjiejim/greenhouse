/**
 * Who may do what in the knowledge base, for every route and tool (data-model.md §1, §12.1):
 * - the team space: every member reads and writes it;
 * - a personal space: its owner does everything; others only what `shares` give them, on the item
 *   or on any folder above it (a share below can widen, never narrow);
 * - an Agent's private reference folder: its owner, and that Agent in its turns; never shared, and
 *   out of sight of the owner's other Agents;
 * - all of it only while the member's knowledge module is on. Admins get nothing extra.
 */

import { and, eq, inArray, isNull, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { KnowledgeAccess } from '@greenhouse/contract';
import { folders, getDb, groupMembers, members, shares, type FolderRow } from '@greenhouse/db';
import { forbidden } from '../../http/errors.js';
import { effectiveModules } from '../members/service.js';

export type Role = KnowledgeAccess;
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export const atLeast = (role: Role | null, needed: Role): boolean => role !== null && RANK[role] >= RANK[needed];
export const best = (a: Role | null | undefined, b: Role | null | undefined): Role | null =>
  !a ? (b ?? null) : !b ? a : RANK[a] >= RANK[b] ? a : b;
const shareRoleOf = (role: string): Role => (role === 'editor' ? 'editor' : 'viewer');

/**
 * How many folders deep the tree may go (a folder at the root is 1). Creating and moving check
 * it under the move lock; a walk that finds more, or a loop, fails instead of stopping short.
 */
export const MAX_FOLDER_DEPTH = 32;

/** A tree walk that reached past the deepest level or went round in a loop: the data is broken. */
function brokenTree(): never {
  throw new Error(`The folder tree is deeper than ${MAX_FOLDER_DEPTH} levels or loops.`);
}

/** Folders and everything below them, each with how far below its root it is. */
export async function walkDown(rootIds: readonly string[]): Promise<Array<{ id: string; depth: number }>> {
  if (!rootIds.length) return [];
  const rows = await getDb().execute<{ id: string; depth: number; looped: boolean }>(sql`
    WITH RECURSIVE sub(id, depth) AS (
      SELECT id, 0 FROM folders WHERE ${inList(folders.id, rootIds)}
      UNION ALL
      SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id WHERE s.depth < ${MAX_FOLDER_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT id, depth, looped FROM sub`);
  const found = new Map<string, number>();
  for (const row of rows) {
    const depth = Number(row.depth);
    if (row.looped || depth >= MAX_FOLDER_DEPTH) brokenTree();
    found.set(row.id, Math.max(found.get(row.id) ?? 0, depth));
  }
  return [...found].map(([id, depth]) => ({ id, depth }));
}

export interface Reader {
  memberId: string;
  name: string;
  locale: 'zh' | 'en';
  groupIds: string[];
  /** In an Agent's turn: that Agent. Its owner's other Agents' private folders are out of its sight. */
  agentId: string | null;
  /** Every folder a share reaches for this reader (shared ones and all below), with the best role. */
  sharedFolders(): Promise<Map<string, Role>>;
  /** In an Agent's turn, the owner's other Agents' private folders and all below them. */
  hiddenFolders(): Promise<string[]>;
}

/** `column IN (…)`, false for an empty list. */
export function inList(column: SQLWrapper, ids: readonly string[]): SQL {
  return ids.length ? inArray(column as never, [...ids]) : sql`false`;
}

/** Shares that reach the reader: as a member, through a group, or the whole workspace. */
export function principalMatch(reader: Pick<Reader, 'memberId' | 'groupIds'>): SQL {
  return or(
    eq(shares.principalType, 'workspace'),
    and(eq(shares.principalType, 'member'), eq(shares.principalId, reader.memberId)),
    reader.groupIds.length
      ? and(eq(shares.principalType, 'group'), inArray(shares.principalId, reader.groupIds))
      : undefined,
  )!;
}

/** Folders and everything below them, as ids. */
export async function subtree(rootIds: readonly string[]): Promise<string[]> {
  return (await walkDown(rootIds)).map((row) => row.id);
}

/** Shared folders and everything below them, each with the best role any share above gives. */
async function reachOf(reader: Pick<Reader, 'memberId' | 'groupIds'>): Promise<Map<string, Role>> {
  const rows = await getDb().execute<{ id: string; rank: number; depth: number; looped: boolean }>(sql`
    WITH RECURSIVE reach(id, rank, depth) AS (
      SELECT ${shares.resourceId}, CASE WHEN ${shares.role} = 'editor' THEN 2 ELSE 1 END, 0
        FROM ${shares} WHERE ${shares.resourceType} = 'folder' AND ${principalMatch(reader)}
      UNION ALL
      SELECT f.id, r.rank, r.depth + 1 FROM folders f JOIN reach r ON f.parent_id = r.id WHERE r.depth < ${MAX_FOLDER_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT id, rank, depth, looped FROM reach`);
  const reach = new Map<string, Role>();
  for (const row of rows) {
    if (row.looped || Number(row.depth) >= MAX_FOLDER_DEPTH) brokenTree();
    if (Number(row.rank) === 2 || !reach.has(row.id)) reach.set(row.id, Number(row.rank) === 2 ? 'editor' : 'viewer');
  }
  return reach;
}

export async function loadReader(memberId: string, agentId: string | null = null): Promise<Reader> {
  const [member] = await getDb()
    .select({ name: members.name, locale: members.locale, modules: members.modules })
    .from(members)
    .where(eq(members.id, memberId));
  if (!member || !effectiveModules(member.modules).knowledge) {
    throw forbidden('The knowledge base is turned off for you.');
  }
  const groupIds = (
    await getDb().select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.memberId, memberId))
  ).map((row) => row.id);
  let shared: Promise<Map<string, Role>> | null = null;
  let hidden: Promise<string[]> | null = null;
  return {
    memberId,
    name: member.name,
    locale: member.locale === 'en' ? 'en' : 'zh',
    groupIds,
    agentId,
    sharedFolders: () => (shared ??= reachOf({ memberId, groupIds })),
    hiddenFolders: () =>
      (hidden ??= agentId
        ? getDb()
            .select({ id: folders.id })
            .from(folders)
            .where(
              and(
                eq(folders.ownerId, memberId),
                sql`${folders.agentId} IS NOT NULL`,
                sql`${folders.agentId} <> ${agentId}`,
              ),
            )
            .then((rows) => subtree(rows.map((row) => row.id)))
        : Promise.resolve([])),
  };
}

/** Each folder's ancestors up to the root, the folder itself at depth 0, by where the walk started. */
export async function walkUp(
  folderIds: readonly string[],
): Promise<Array<{ start: string; id: string; name: string; depth: number }>> {
  if (!folderIds.length) return [];
  const rows = await getDb().execute<{ start: string; id: string; name: string; depth: number; looped: boolean }>(sql`
    WITH RECURSIVE up(start, id, parent_id, name, depth) AS (
      SELECT id, id, parent_id, name, 0 FROM folders WHERE ${inList(folders.id, folderIds)}
      UNION ALL
      SELECT u.start, f.id, f.parent_id, f.name, u.depth + 1 FROM folders f JOIN up u ON f.id = u.parent_id WHERE u.depth < ${MAX_FOLDER_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT start, id, name, depth, looped FROM up`);
  return [...rows].map((row) => {
    const depth = Number(row.depth);
    if (row.looped || depth >= MAX_FOLDER_DEPTH) brokenTree();
    return { start: row.start, id: row.id, name: row.name, depth };
  });
}

/** The folder and the folders above it, the folder first. */
export async function chainOf(folderId: string | null): Promise<FolderRow[]> {
  if (!folderId) return [];
  const steps = await walkUp([folderId]);
  const order = new Map(steps.map((step) => [step.id, step.depth]));
  if (!order.size) return [];
  const rows = await getDb()
    .select()
    .from(folders)
    .where(inArray(folders.id, [...order.keys()]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** The roles shares give the reader on docs directly, by doc id. */
export async function docShareRoles(reader: Reader, docIds: readonly string[]): Promise<Map<string, Role>> {
  if (!docIds.length) return new Map();
  const rows = await getDb()
    .select({ id: shares.resourceId, role: shares.role })
    .from(shares)
    .where(and(eq(shares.resourceType, 'doc'), inArray(shares.resourceId, [...docIds]), principalMatch(reader)));
  const roles = new Map<string, Role>();
  for (const row of rows) roles.set(row.id, best(roles.get(row.id), shareRoleOf(row.role))!);
  return roles;
}

export interface Placed {
  type: 'folder' | 'doc' | 'file';
  id: string;
  space: 'team' | 'personal';
  ownerId: string | null;
  /** The folder it is in (a folder's parent). */
  folderId: string | null;
}

/** The Agent whose private folder holds an item: the agent of the topmost folder above it. */
export const agentOfChain = (chain: readonly FolderRow[]): string | null => chain[chain.length - 1]?.agentId ?? null;

/**
 * The reader's role on an item, given the folders above it (`chain`: nearest first, and for a
 * folder itself first) and, for a doc, the role a share on the doc gives. Null: out of sight.
 */
export async function roleIn(
  reader: Reader,
  item: Placed,
  chain: readonly FolderRow[],
  docShare: Role | null = null,
): Promise<Role | null> {
  if (item.space === 'team') return 'editor';
  const agentId = agentOfChain(chain);
  if (item.ownerId === reader.memberId) {
    // Another of the owner's Agents' private folder is out of this Agent's sight.
    return agentId && reader.agentId && agentId !== reader.agentId ? null : 'owner';
  }
  if (agentId) return null;
  const reach = await reader.sharedFolders();
  const inherited = item.type === 'folder' ? reach.get(item.id) : item.folderId ? reach.get(item.folderId) : null;
  return best(inherited, docShare);
}

/**
 * The same for many items of one listing at once (their chains are not needed: an item in the
 * team space is everyone's, one in the reader's own space theirs, the rest comes from shares).
 * `hidden` holds the folders out of an Agent's sight.
 */
export async function rolesOf(reader: Reader, items: readonly Placed[]): Promise<Map<string, Role>> {
  const [reach, hidden, docShares] = await Promise.all([
    reader.sharedFolders(),
    reader.hiddenFolders(),
    docShareRoles(
      reader,
      items.filter((item) => item.type === 'doc').map((item) => item.id),
    ),
  ]);
  const hiddenSet = new Set(hidden);
  const roles = new Map<string, Role>();
  for (const item of items) {
    let role: Role | null;
    if (item.space === 'team') role = 'editor';
    else if (item.ownerId === reader.memberId) {
      const inside = item.type === 'folder' ? item.id : item.folderId;
      role = inside && hiddenSet.has(inside) ? null : 'owner';
    } else {
      const inherited = item.type === 'folder' ? reach.get(item.id) : item.folderId ? reach.get(item.folderId) : null;
      role = best(inherited, item.type === 'doc' ? docShares.get(item.id) : null);
    }
    if (role) roles.set(item.id, role);
  }
  return roles;
}

/**
 * A condition for rows of docs or files the reader may read: the team space, their own space
 * (minus other Agents' folders in an Agent's turn), and what shares reach.
 */
export async function readableWhere(
  reader: Reader,
  table: { id: SQLWrapper; space: SQLWrapper; ownerId: SQLWrapper; folderId: SQLWrapper },
  type: 'doc' | 'file',
): Promise<SQL> {
  const [reach, hidden] = await Promise.all([reader.sharedFolders(), reader.hiddenFolders()]);
  const shared = [...reach.keys()];
  return or(
    sql`${table.space} = 'team'`,
    and(
      sql`${table.ownerId} = ${reader.memberId}`,
      hidden.length ? or(isNull(table.folderId as never), notInArray(table.folderId as never, hidden)) : undefined,
    ),
    shared.length ? inArray(table.folderId as never, shared) : undefined,
    type === 'doc'
      ? sql`EXISTS (SELECT 1 FROM ${shares} WHERE ${shares.resourceType} = 'doc' AND ${shares.resourceId} = ${table.id} AND ${principalMatch(reader)})`
      : undefined,
  )!;
}
