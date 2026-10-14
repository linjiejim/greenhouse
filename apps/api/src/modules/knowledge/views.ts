/** Rows of the tree as the API shows them. Their order is the database's (service.ts treePage). */

import { inArray } from 'drizzle-orm';
import type { KnowledgeItem, KnowledgeShare, MemberRef } from '@greenhouse/contract';
import { agents, getDb, groups, members, type DocRow, type FileRow, type FolderRow } from '@greenhouse/db';
import type { Placed, Role } from './access.js';

/** What a tree row needs, whatever it is. */
export interface Source extends Placed {
  name: string;
  sortOrder: number;
  agentId: string | null;
  isTemplate: boolean;
  contentType: string | null;
  sizeBytes: number | null;
  archivedAt: string | null;
  updatedAt: string;
}

export const folderSource = (
  row: Pick<
    FolderRow,
    'id' | 'name' | 'space' | 'parentId' | 'ownerId' | 'sortOrder' | 'agentId' | 'archivedAt' | 'updatedAt'
  >,
): Source => ({
  type: 'folder',
  id: row.id,
  name: row.name,
  space: row.space,
  folderId: row.parentId,
  ownerId: row.ownerId,
  sortOrder: row.sortOrder,
  agentId: row.agentId,
  isTemplate: false,
  contentType: null,
  sizeBytes: null,
  archivedAt: row.archivedAt,
  updatedAt: row.updatedAt,
});

export type DocListRow = Pick<
  DocRow,
  'id' | 'title' | 'space' | 'folderId' | 'ownerId' | 'sortOrder' | 'isTemplate' | 'archivedAt' | 'updatedAt'
>;

export const docSource = (row: DocListRow): Source => ({
  type: 'doc',
  id: row.id,
  name: row.title,
  space: row.space,
  folderId: row.folderId,
  ownerId: row.ownerId,
  sortOrder: row.sortOrder,
  agentId: null,
  isTemplate: row.isTemplate,
  contentType: null,
  sizeBytes: null,
  archivedAt: row.archivedAt,
  updatedAt: row.updatedAt,
});

export type FileListRow = Pick<
  FileRow,
  'id' | 'name' | 'space' | 'folderId' | 'ownerId' | 'contentType' | 'sizeBytes' | 'archivedAt' | 'updatedAt' | 'meta'
>;

export const fileSource = (row: FileListRow): Source => ({
  type: 'file',
  id: row.id,
  name: row.name,
  // Tree queries never return a file without a space; were one to slip through, it is nobody's.
  space: row.space ?? 'personal',
  folderId: row.folderId,
  ownerId: row.ownerId,
  sortOrder: typeof row.meta.sort_order === 'number' ? row.meta.sort_order : 0,
  agentId: null,
  isTemplate: false,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  archivedAt: row.archivedAt,
  updatedAt: row.updatedAt,
});

export const toItem = (source: Source, access: Role, shared: boolean): KnowledgeItem => ({
  type: source.type,
  id: source.id,
  name: source.name,
  space: source.space,
  folder_id: source.folderId,
  owner_id: source.ownerId,
  sort_order: source.sortOrder,
  access,
  shared,
  agent_id: source.agentId,
  is_template: source.isTemplate,
  content_type: source.contentType,
  size_bytes: source.sizeBytes,
  archived_at: source.archivedAt,
  updated_at: source.updatedAt,
});

/** Names of members, for who wrote what. */
export async function memberNames(ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await getDb()
    .select({ id: members.id, name: members.name })
    .from(members)
    .where(inArray(members.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function agentNames(ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await getDb()
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export const refOf = (names: Map<string, string>, id: string | null): MemberRef | null =>
  id ? { id, name: names.get(id) ?? '' } : null;

/** Share rows with the names of who they reach. */
export async function shareViews(
  rows: ReadonlyArray<{ principalType: 'member' | 'group' | 'workspace'; principalId: string | null; role: string }>,
): Promise<KnowledgeShare[]> {
  const memberIds = rows.filter((row) => row.principalType === 'member').map((row) => row.principalId!);
  const groupIds = rows.filter((row) => row.principalType === 'group').map((row) => row.principalId!);
  const [people, teams] = await Promise.all([
    memberNames(memberIds),
    groupIds.length
      ? getDb()
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(inArray(groups.id, groupIds))
          .then((found) => new Map(found.map((group) => [group.id, group.name])))
      : Promise.resolve(new Map<string, string>()),
  ]);
  return rows.map((row) => ({
    type: row.principalType,
    id: row.principalId,
    name:
      row.principalType === 'member'
        ? (people.get(row.principalId!) ?? '')
        : row.principalType === 'group'
          ? (teams.get(row.principalId!) ?? '')
          : '',
    role: row.role === 'editor' ? 'editor' : 'viewer',
  }));
}
