/**
 * What the knowledge directory shows: the space (团队 / 个人 / 分享给我, kept in this browser) and
 * which folders are open. Shared by the directory, its 新建 button and the pages, which reveal what
 * they open (its space, and the folders above it).
 */

import { useSyncExternalStore } from 'react';
import type { KnowledgeScope } from '@greenhouse/contract';
import { store, stored } from '../../lib/media';
import { KNOWLEDGE_SCOPES } from '../../lib/router';

let scope: KnowledgeScope = stored('knowledge-scope', 'team', KNOWLEDGE_SCOPES);
let open: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setKnowledgeScope(next: KnowledgeScope) {
  if (next === scope) return;
  scope = next;
  store('knowledge-scope', next);
  changed();
}

export const useKnowledgeScope = () =>
  useSyncExternalStore(
    subscribe,
    () => scope,
    () => scope,
  );

/** Opens these folders in the directory (the ones above what a page shows). */
export function revealFolders(ids: readonly string[]) {
  if (ids.every((id) => open.has(id))) return;
  open = new Set([...open, ...ids]);
  changed();
}

export function toggleFolder(id: string, expand?: boolean) {
  const next = new Set(open);
  if (expand ?? !next.has(id)) next.add(id);
  else next.delete(id);
  open = next;
  changed();
}

export const useOpenFolders = () =>
  useSyncExternalStore(
    subscribe,
    () => open,
    () => open,
  );
