/**
 * The knowledge pages' plain rules: where an item opens, who may do what with it, list order,
 * where a drop lands and what a reorder sends, and comments' mentions. No React here.
 */

import type { KnowledgeDoc, KnowledgeItem, KnowledgeScope, KnowledgeSpace, MemberRef } from '@greenhouse/contract';
import { mentionHref } from '@greenhouse/contract';
import type { Route } from '../../lib/router';

export type ItemRef = Pick<KnowledgeItem, 'type' | 'id'>;
export const itemKey = (item: ItemRef) => `${item.type}:${item.id}`;

/** Where an item opens: a doc on its page, a folder on its own, a file previewed over its folder. */
export function routeOf(item: Pick<KnowledgeItem, 'type' | 'id' | 'folder_id' | 'space'>): Route {
  if (item.type === 'doc') return { page: 'doc', id: item.id };
  if (item.type === 'folder') return { page: 'folder', id: item.id };
  return item.folder_id
    ? { page: 'folder', id: item.folder_id, file: item.id }
    : { page: 'knowledge', space: item.space, file: item.id };
}

/** The space an item shows under in the directory: mine, the team's, or shared with me. */
export function scopeOf(item: { space: KnowledgeSpace; owner_id: string | null }, me: string): KnowledgeScope {
  if (item.space === 'team') return 'team';
  return item.owner_id === me ? 'personal' : 'shared';
}

export const canEdit = (item: Pick<KnowledgeItem, 'access' | 'archived_at'>) =>
  item.access !== 'viewer' && !item.archived_at;

/** Archiving and restoring: anyone who may change the team space, only the owner of a personal item. */
export const canArchive = (item: Pick<KnowledgeItem, 'access' | 'space'>) =>
  item.space === 'team' ? item.access !== 'viewer' : item.access === 'owner';

/**
 * Sharing: only the owner of a personal item, never an Agent's private folder or what is in it,
 * never archived (the team space is everyone's already).
 */
export const canShare = (item: Pick<KnowledgeItem, 'type' | 'access' | 'space' | 'archived_at' | 'agent_id'>) =>
  item.space === 'personal' && item.access === 'owner' && !item.archived_at && !item.agent_id;

/** An Agent's private folder stays at the top of its owner's space. */
export const canMove = (item: Pick<KnowledgeItem, 'type' | 'access' | 'archived_at' | 'agent_id'>) =>
  canEdit(item) && !(item.type === 'folder' && item.agent_id);

/** A doc read as a row of the tree (for menus that work on both). */
export function docItem(doc: KnowledgeDoc): KnowledgeItem {
  return {
    type: 'doc',
    id: doc.id,
    name: doc.title,
    space: doc.space,
    folder_id: doc.folder_id,
    owner_id: doc.owner_id,
    sort_order: doc.sort_order,
    access: doc.access,
    shared: doc.shared,
    agent_id: doc.agent_id,
    is_template: doc.is_template,
    content_type: null,
    size_bytes: null,
    archived_at: doc.archived_at,
    updated_at: doc.updated_at,
  };
}

export const SORTS = ['manual', 'name', 'updated'] as const;
export type Sort = (typeof SORTS)[number];

/** A folder's items in the chosen order; `manual` keeps the server's tree order. */
export function sortItems(items: readonly KnowledgeItem[], sort: Sort): KnowledgeItem[] {
  if (sort === 'manual') return [...items];
  const names = new Intl.Collator('zh-u-co-pinyin', { numeric: true });
  const folderFirst = (a: KnowledgeItem, b: KnowledgeItem) =>
    (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1);
  return [...items].sort((a, b) =>
    sort === 'name'
      ? folderFirst(a, b) || names.compare(a.name, b.name) || a.id.localeCompare(b.id)
      : b.updated_at.localeCompare(a.updated_at) || names.compare(a.name, b.name) || a.id.localeCompare(b.id),
  );
}

/** Rows that sit in one folder (or one space root): only those can be put in order together. */
export const oneFolder = (items: readonly Pick<KnowledgeItem, 'folder_id' | 'space' | 'owner_id'>[]) =>
  items.every(
    (item) =>
      item.folder_id === items[0]?.folder_id && item.space === items[0]?.space && item.owner_id === items[0]?.owner_id,
  );

export const matchesName = (name: string, query: string) =>
  !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

export type DropPosition = 'before' | 'after' | 'into';

/**
 * Where a drag over a row would land: the middle of a folder goes into it, the top and bottom
 * edges (a quarter each, half for docs and files) go before or after it.
 */
export function dropPosition(offsetY: number, height: number, isFolder: boolean): DropPosition {
  const ratio = height > 0 ? offsetY / height : 0;
  if (isFolder) return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into';
  return ratio < 0.5 ? 'before' : 'after';
}

/**
 * The hand order of a folder after `moving` is dropped before or after `target`: the whole list,
 * as POST /api/knowledge/reorder wants it.
 */
export function reorderAround(
  siblings: readonly ItemRef[],
  moving: ItemRef,
  target: ItemRef,
  position: 'before' | 'after',
): ItemRef[] {
  const rest = siblings.filter((item) => itemKey(item) !== itemKey(moving));
  const at = rest.findIndex((item) => itemKey(item) === itemKey(target));
  if (at < 0) return [...rest, moving];
  rest.splice(position === 'before' ? at : at + 1, 0, moving);
  return rest.map(({ type, id }) => ({ type, id }));
}

/** A member name inside a mention link: brackets escaped, as the editor writes them. */
const escapeName = (name: string) => name.replace(/[\\[\]]/g, '\\$&');

/**
 * A comment as typed, with the members picked from the `@` list written as mention links
 * (`[@Name](member:<id>)`) so they are told; other text is left as it is.
 */
export function withMentions(text: string, picked: readonly MemberRef[]): string {
  let out = text;
  const byLength = [...new Map(picked.map((member) => [member.id, member])).values()].sort(
    (a, b) => b.name.length - a.name.length,
  );
  for (const member of byLength) {
    const plain = `@${member.name}`;
    const pattern = new RegExp(`(^|[^\\[\\w])${plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g');
    out = out.replace(
      pattern,
      (_match, before: string) => `${before}[@${escapeName(member.name)}](${mentionHref(member.id)})`,
    );
  }
  return out;
}

/** The `@word` being typed just before the caret, if any. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

/** A file's kind, for its icon. */
export function fileKind(contentType: string | null): 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'other' {
  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('text/') || /json|yaml|csv|markdown/.test(type)) return 'text';
  return 'other';
}

/** The details of a refused save (409 `stale_version`): which version is there now, who saved it and when. */
export function staleDetails(
  details: unknown,
): { version: number; updatedBy: string | null; updatedAt: string } | null {
  const value = details as { version?: unknown; updated_by?: unknown; updated_at?: unknown } | undefined;
  if (!value || typeof value.version !== 'number' || typeof value.updated_at !== 'string') return null;
  return {
    version: value.version,
    updatedBy: typeof value.updated_by === 'string' ? value.updated_by : null,
    updatedAt: value.updated_at,
  };
}
