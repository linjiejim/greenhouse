/**
 * Who may do what in the knowledge base, for every route and tool (data-model.md §1, §12.1):
 * - the team space: every member reads and writes it;
 * - a personal space: its owner does everything; others only what `shares` give them, on the item
 *   or on any folder above it (a share below can widen, never narrow);
 * - an Agent's private reference folder: its owner, and that Agent in its turns; never shared, and
 *   out of sight of the owner's other Agents;
 * - all of it only while the member's knowledge module is on. Admins get nothing extra.
 */

import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { KnowledgeAccess } from '@greenhouse/contract';
import { agents, docs, folders, getDb, groupMembers, members, shares, type FolderRow } from '@greenhouse/db';
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
  /** Public Agent reads are confined to these live publication folders, with viewer access. */
  publicationFolders?: string[];
  /** Every folder a share reaches for this reader (shared ones and all below), with the best role. */
  sharedFolders(): Promise<Map<string, Role>>;
  /** In an Agent's turn, the owner's other Agents' private folders and all below them. */
  hiddenFolders(): Promise<string[]>;
  /**
   * Docs shared with the reader one by one that sit in an Agent's private folder. Sharing refuses
   * those, so this is a backstop: such a share opens nothing.
   */
  privateSharedDocs(): Promise<string[]>;
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

/**
 * Shared folders and everything below them, each with the best role any share above gives. A
 * share never reaches into an Agent's private folder, even one a race or a hand-written row made.
 */
async function reachOf(reader: Pick<Reader, 'memberId' | 'groupIds'>): Promise<Map<string, Role>> {
  const granted = await getDb()
    .select({ id: shares.resourceId })
    .from(shares)
    .where(and(eq(shares.resourceType, 'folder'), principalMatch(reader)));
  if (!granted.length) return new Map();
  const blocked = [...(await insideAgentFolders(granted.map((row) => row.id)))];
  const rows = await getDb().execute<{ id: string; rank: number; depth: number; looped: boolean }>(sql`
    WITH RECURSIVE reach(id, rank, depth) AS (
      SELECT ${shares.resourceId}, CASE WHEN ${shares.role} = 'editor' THEN 2 ELSE 1 END, 0
        FROM ${shares} WHERE ${shares.resourceType} = 'folder' AND ${principalMatch(reader)}
          AND ${blocked.length ? notInArray(shares.resourceId, blocked) : sql`true`}
      UNION ALL
      SELECT f.id, r.rank, r.depth + 1 FROM folders f JOIN reach r ON f.parent_id = r.id
        WHERE r.depth < ${MAX_FOLDER_DEPTH} AND f.agent_id IS NULL
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
  let publicationFolders: string[] | undefined;
  if (agentId) {
    const [agent] = await getDb().select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw forbidden('This Agent is unavailable.');
    if (agent.ownerId !== memberId) {
      const [grant] = await getDb()
        .select({ id: shares.id })
        .from(shares)
        .where(
          and(eq(shares.resourceType, 'agent'), eq(shares.resourceId, agentId), principalMatch({ memberId, groupIds })),
        )
        .limit(1);
      const [owner] = await getDb().select().from(members).where(eq(members.id, agent.ownerId));
      publicationFolders = [];
      if (
        grant &&
        agent.visibility === 'public' &&
        agent.publishedVersion !== null &&
        !agent.pausedAt &&
        !agent.archivedAt &&
        owner?.status === 'active' &&
        effectiveModules(owner.modules).knowledge
      ) {
        const roots = await getDb()
          .select()
          .from(folders)
          .where(
            and(
              inList(folders.id, agent.publication.folderIds ?? []),
              eq(folders.ownerId, agent.ownerId),
              eq(folders.space, 'personal'),
              isNull(folders.archivedAt),
            ),
          );
        const privateRoots = await insideAgentFolders(roots.map((row) => row.id));
        const below = await subtree(roots.filter((row) => !privateRoots.has(row.id)).map((row) => row.id));
        const live = await getDb()
          .select()
          .from(folders)
          .where(
            and(
              inList(folders.id, below),
              eq(folders.ownerId, agent.ownerId),
              eq(folders.space, 'personal'),
              isNull(folders.archivedAt),
            ),
          );
        const privateFolders = await insideAgentFolders(live.map((row) => row.id));
        publicationFolders = live.filter((row) => !privateFolders.has(row.id)).map((row) => row.id);
      }
    }
  }
  let shared: Promise<Map<string, Role>> | null = null;
  let hidden: Promise<string[]> | null = null;
  let privateDocs: Promise<string[]> | null = null;
  return {
    memberId,
    name: member.name,
    locale: member.locale === 'en' ? 'en' : 'zh',
    groupIds,
    agentId,
    ...(publicationFolders ? { publicationFolders } : {}),
    sharedFolders: () =>
      (shared ??= publicationFolders
        ? Promise.resolve(new Map(publicationFolders.map((id) => [id, 'viewer' as const])))
        : reachOf({ memberId, groupIds })),
    privateSharedDocs: () =>
      (privateDocs ??= getDb()
        .select({ id: docs.id, folderId: docs.folderId })
        .from(shares)
        .innerJoin(docs, eq(docs.id, shares.resourceId))
        .where(and(eq(shares.resourceType, 'doc'), principalMatch({ memberId, groupIds }), isNotNull(docs.folderId)))
        .then(async (rows) => {
          const inside = await insideAgentFolders([...new Set(rows.map((row) => row.folderId!))]);
          return rows.filter((row) => inside.has(row.folderId!)).map((row) => row.id);
        })),
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
): Promise<Array<{ start: string; id: string; name: string; agentId: string | null; depth: number }>> {
  if (!folderIds.length) return [];
  const rows = await getDb().execute<{
    start: string;
    id: string;
    name: string;
    agent_id: string | null;
    depth: number;
    looped: boolean;
  }>(sql`
    WITH RECURSIVE up(start, id, parent_id, name, agent_id, depth) AS (
      SELECT id, id, parent_id, name, agent_id, 0 FROM folders WHERE ${inList(folders.id, folderIds)}
      UNION ALL
      SELECT u.start, f.id, f.parent_id, f.name, f.agent_id, u.depth + 1 FROM folders f JOIN up u ON f.id = u.parent_id WHERE u.depth < ${MAX_FOLDER_DEPTH}
    ) CYCLE id SET looped USING trail
    SELECT start, id, name, agent_id, depth, looped FROM up`);
  return [...rows].map((row) => {
    const depth = Number(row.depth);
    if (row.looped || depth >= MAX_FOLDER_DEPTH) brokenTree();
    return { start: row.start, id: row.id, name: row.name, agentId: row.agent_id, depth };
  });
}

/** Of these folders, the ones in an Agent's private folder (its top folder included). */
export async function insideAgentFolders(folderIds: readonly string[]): Promise<Set<string>> {
  return new Set((await walkUp(folderIds)).filter((row) => row.agentId).map((row) => row.start));
}

/**
 * Of these docs, the ones a member may read now, as themselves (none while their knowledge
 * module is off). Conversations use it so a source under a reply reaches only who may open it.
 */
export async function readableDocs(
  memberId: string,
  docIds: readonly string[],
  agentId: string | null = null,
): Promise<Set<string>> {
  if (!docIds.length) return new Set();
  const reader = await loadReader(memberId).catch(() => null);
  if (!reader) return new Set();
  const grant = agentId ? await loadReader(memberId, agentId).catch(() => null) : null;
  const rows = await getDb()
    .select({ id: docs.id })
    .from(docs)
    .where(
      and(
        inList(docs.id, docIds),
        or(
          await readableWhere(reader, docs, 'doc'),
          grant?.publicationFolders ? and(isNull(docs.archivedAt), await readableWhere(grant, docs, 'doc')) : undefined,
        ),
      ),
    );
  return new Set(rows.map((row) => row.id));
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
  if (reader.publicationFolders) {
    const placed = item.type === 'folder' ? item.id : item.folderId;
    return placed && reader.publicationFolders.includes(placed) && !agentOfChain(chain) ? 'viewer' : null;
  }
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
 * `hidden` holds the folders out of an Agent's sight. What a share would open inside an Agent's
 * private folder stays closed (a backstop: sharing refuses it).
 */
export async function rolesOf(reader: Reader, items: readonly Placed[]): Promise<Map<string, Role>> {
  if (reader.publicationFolders)
    return new Map(
      items.flatMap((item) => {
        const placed = item.type === 'folder' ? item.id : item.folderId;
        return placed && reader.publicationFolders!.includes(placed) ? [[item.id, 'viewer' as const]] : [];
      }),
    );
  const throughShares = items.filter((item) => item.space !== 'team' && item.ownerId !== reader.memberId);
  const placeOf = (item: Placed) => (item.type === 'folder' ? item.id : item.folderId);
  const [reach, hidden, docShares, privateFolders] = await Promise.all([
    reader.sharedFolders(),
    reader.hiddenFolders(),
    docShareRoles(
      reader,
      throughShares.filter((item) => item.type === 'doc').map((item) => item.id),
    ),
    insideAgentFolders([...new Set(throughShares.flatMap((item) => placeOf(item) ?? []))]),
  ]);
  const hiddenSet = new Set(hidden);
  const roles = new Map<string, Role>();
  for (const item of items) {
    let role: Role | null;
    const inside = placeOf(item);
    if (item.space === 'team') role = 'editor';
    else if (item.ownerId === reader.memberId) role = inside && hiddenSet.has(inside) ? null : 'owner';
    else if (inside && privateFolders.has(inside)) role = null;
    else {
      const inherited = inside ? reach.get(inside) : null;
      role = best(inherited, item.type === 'doc' ? docShares.get(item.id) : null);
    }
    if (role) roles.set(item.id, role);
  }
  return roles;
}

/**
 * A condition for rows of docs or files the reader may read: the team space, their own space
 * (minus other Agents' folders in an Agent's turn), and what shares reach (never inside an
 * Agent's private folder).
 */
export async function readableWhere(
  reader: Reader,
  table: { id: SQLWrapper; space: SQLWrapper; ownerId: SQLWrapper; folderId: SQLWrapper },
  type: 'doc' | 'file',
): Promise<SQL> {
  if (reader.publicationFolders) return inList(table.folderId, reader.publicationFolders);
  const [reach, hidden, privateDocs] = await Promise.all([
    reader.sharedFolders(),
    reader.hiddenFolders(),
    type === 'doc' ? reader.privateSharedDocs() : Promise.resolve([]),
  ]);
  const shared = [...reach.keys()];
  return or(
    sql`${table.space} = 'team'`,
    and(
      sql`${table.ownerId} = ${reader.memberId}`,
      hidden.length ? or(isNull(table.folderId as never), notInArray(table.folderId as never, hidden)) : undefined,
    ),
    shared.length ? inArray(table.folderId as never, shared) : undefined,
    type === 'doc'
      ? and(
          sql`EXISTS (SELECT 1 FROM ${shares} WHERE ${shares.resourceType} = 'doc' AND ${shares.resourceId} = ${table.id} AND ${principalMatch(reader)})`,
          privateDocs.length ? notInArray(table.id as never, privateDocs) : undefined,
        )
      : undefined,
  )!;
}
