/**
 * Rules of a document's share panel (src/knowledge/use-doc-shares.ts), React-free. Only a
 * private document's owner shares it (plugins/knowledge access.ts `canManageSharing`); team
 * documents are open to every member already and take no grants. The station stays the judge.
 */

import type { KbDoc, KbShare } from '../shared/greenhouse-types';

export type ShareRole = KbShare['role'];

export const SHARE_ROLES: readonly ShareRole[] = ['reader', 'editor'];

/** Whether the document shows a Share entry: mine and private. */
export function canShareDoc(doc: Pick<KbDoc, 'visibility' | 'access'> | null | undefined): boolean {
  return !!doc && doc.visibility === 'private' && doc.access === 'owner';
}

/** People with a grant, by name. */
export function sortedShares(shares: readonly KbShare[]): KbShare[] {
  return [...shares].sort((a, b) => a.name.localeCompare(b.name));
}

/** The people it may still be shared with: everyone offered without a grant, by name. */
export function shareCandidates<U extends { id: string; nickname: string }>(
  users: readonly U[],
  shares: readonly KbShare[],
): U[] {
  const taken = new Set(shares.map((share) => share.target));
  return users.filter((user) => !taken.has(user.id)).sort((a, b) => a.nickname.localeCompare(b.nickname));
}
