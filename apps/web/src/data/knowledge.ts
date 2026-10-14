/**
 * 知识库 (KNOW-01 to KNOW-16) in the query cache. Tree lists live under `knowledge` (one
 * `knowledge.changed` refetches all of them); a doc and what hangs off it under `docs`. Saves are
 * not here: the doc page sends them with the version it started from (DocEditor).
 */

import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CreateDocInput,
  CreateFolderInput,
  DocPresence,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSpace,
  PresenceState,
  ReorderInput,
  ShareInput,
  UpdateDocInput,
  UpdateFileInput,
  UpdateFolderInput,
} from '@greenhouse/contract';
import { api } from '../lib/api';
import { saveBlob } from '../lib/save';
import { keys } from './query';

/** Every list of the tree: folders, roots, recent docs, templates, archived, search, shares, files. */
export const refreshTree = (client: QueryClient) => client.invalidateQueries({ queryKey: keys.knowledge });

export function useKnowledgeRoots(scope: KnowledgeScope, enabled = true) {
  const query = useQuery({
    queryKey: keys.knowledgeRoots(scope),
    queryFn: () => api.knowledge.folders.roots(scope),
    enabled,
  });
  return { ...query, items: query.data?.items ?? [] };
}

export function useFolder(id: string | null, enabled = true) {
  return useQuery({
    queryKey: keys.knowledgeFolder(id ?? ''),
    queryFn: () => api.knowledge.folders.get(id!),
    enabled: !!id && enabled,
  });
}

/** Docs I can read, newest change first (the knowledge home). */
export function useRecentDocs() {
  const query = useInfiniteQuery({
    queryKey: keys.knowledgeRecent,
    queryFn: ({ pageParam }) => api.knowledge.docs.list({ cursor: pageParam, limit: 30, template: false }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  return { ...query, items: query.data?.pages.flatMap((page) => page.items) ?? [] };
}

export function useTemplates(enabled = true) {
  const query = useQuery({
    queryKey: keys.knowledgeTemplates,
    queryFn: () => api.knowledge.docs.list({ template: true, limit: 100 }),
    enabled,
  });
  return { ...query, items: query.data?.items ?? [] };
}

export function useArchived(space: KnowledgeSpace) {
  const query = useQuery({ queryKey: keys.knowledgeArchived(space), queryFn: () => api.knowledge.archived(space) });
  return { ...query, items: query.data?.items ?? [] };
}

/** Full text over what I may read (KNOW-13), in a scope or inside a folder. */
export function useKnowledgeSearch(q: string, where: { space?: KnowledgeScope; folder_id?: string } = {}) {
  const query = useQuery({
    queryKey: keys.knowledgeSearch(q, where.space, where.folder_id),
    queryFn: () => api.knowledge.search({ q, ...where, limit: 30 }),
    enabled: q.length > 0,
    staleTime: 10_000,
  });
  return { ...query, items: query.data?.items ?? [] };
}

export function useDoc(id: string) {
  return useQuery({ queryKey: keys.doc(id), queryFn: () => api.knowledge.docs.get(id) });
}

export function useDocVersions(id: string) {
  const query = useInfiniteQuery({
    queryKey: keys.docVersions(id),
    queryFn: ({ pageParam }) => api.knowledge.docs.versions(id, { cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  return { ...query, items: query.data?.pages.flatMap((page) => page.items) ?? [] };
}

export function useDocVersion(id: string, version: number | null) {
  return useQuery({
    queryKey: keys.docVersion(id, version ?? 0),
    queryFn: () => api.knowledge.docs.version(id, version!),
    enabled: version !== null,
    staleTime: Infinity,
  });
}

/** What changed from `from` to `to` (immutable versions: never stale). */
export function useDocDiff(id: string, from: number, to: number, mode: 'line' | 'word', enabled = true) {
  return useQuery({
    queryKey: keys.docDiff(id, from, to, mode),
    queryFn: () => api.knowledge.docs.diff(id, { from, to, mode }),
    enabled: enabled && from > 0 && to > from,
    staleTime: Infinity,
  });
}

export function useBacklinks(id: string) {
  const query = useQuery({ queryKey: keys.docBacklinks(id), queryFn: () => api.knowledge.docs.backlinks(id) });
  return { ...query, items: query.data?.items ?? [] };
}

export function useDocComments(id: string) {
  const query = useInfiniteQuery({
    queryKey: keys.docComments(id),
    queryFn: ({ pageParam }) => api.knowledge.docs.comments(id, { cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  return { ...query, items: query.data?.pages.flatMap((page) => page.items) ?? [] };
}

export function useShares(type: 'folder' | 'doc', id: string) {
  return useQuery({
    queryKey: keys.knowledgeShares(type, id),
    queryFn: () => (type === 'folder' ? api.knowledge.folders.shares(id) : api.knowledge.docs.shares(id)),
  });
}

/** A file with its preview kind and a URL signed for me, refreshed well before it ends. */
export function useKnowledgeFile(id: string | null) {
  return useQuery({
    queryKey: keys.knowledgeFile(id ?? ''),
    queryFn: () => api.knowledge.files.get(id!),
    enabled: !!id,
    staleTime: 30 * 60_000,
    refetchInterval: 45 * 60_000,
  });
}

/** How often an open doc says it is still open (KNOW-06): a minute of silence is leaving. */
const BEAT_MS = 20_000;

/**
 * Who else has the doc open, and telling them I do: a heartbeat now, every 20 seconds and when the
 * state changes, and leaving when the page goes. `doc.presence` keeps the list fresh in between.
 */
export function usePresence(id: string, state: PresenceState | null) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: keys.docPresence(id),
    queryFn: () => api.knowledge.docs.presence(id),
    staleTime: Infinity,
    enabled: state !== null,
  });
  const joined = useRef(false);
  useEffect(() => {
    if (!state) return;
    joined.current = true;
    const beat = () =>
      void api.knowledge.docs
        .beat(id, state)
        .then((result) => client.setQueryData(keys.docPresence(id), result))
        .catch(() => undefined);
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => clearInterval(timer);
  }, [client, id, state]);
  // Leaving is once per page, not per state: going from editing back to viewing is not leaving.
  useEffect(
    () => () => {
      if (!joined.current) return;
      joined.current = false;
      void api.knowledge.docs.leave(id).catch(() => undefined);
    },
    [id],
  );
  return (query.data?.items ?? []) as DocPresence[];
}

/** The tree's writes; each refreshes the lists (other screens hear `knowledge.changed`). */
export function useKnowledgeActions() {
  const client = useQueryClient();
  const settle = () => void refreshTree(client);
  const settleDoc = (id: string) => {
    settle();
    void client.invalidateQueries({ queryKey: keys.doc(id) });
  };
  return {
    createFolder: useMutation({
      mutationFn: (input: CreateFolderInput) => api.knowledge.folders.create(input),
      onSettled: settle,
    }),
    updateFolder: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateFolderInput }) => api.knowledge.folders.update(id, input),
      onSettled: settle,
    }),
    createDoc: useMutation({
      mutationFn: (input: CreateDocInput) => api.knowledge.docs.create(input),
      onSettled: settle,
    }),
    /** Tags, the template flag or a move: no new version (saves go through the editor). */
    updateDoc: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateDocInput }) => api.knowledge.docs.update(id, input),
      onSuccess: (doc) => client.setQueryData(keys.doc(doc.id), doc),
      onSettled: settle,
    }),
    updateFile: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateFileInput }) => api.knowledge.files.update(id, input),
      onSettled: settle,
    }),
    reorder: useMutation({
      mutationFn: (input: ReorderInput) => api.knowledge.reorder(input),
      onSettled: settle,
    }),
    archive: useMutation({
      mutationFn: (item: Pick<KnowledgeItem, 'type' | 'id'>) =>
        item.type === 'folder'
          ? api.knowledge.folders.archive(item.id)
          : item.type === 'doc'
            ? api.knowledge.docs.archive(item.id)
            : api.knowledge.files.archive(item.id),
      onSettled: (_data, _error, item) => (item.type === 'doc' ? settleDoc(item.id) : settle()),
    }),
    restore: useMutation({
      mutationFn: async (item: Pick<KnowledgeItem, 'type' | 'id'>) => {
        if (item.type === 'folder') await api.knowledge.folders.restore(item.id);
        else if (item.type === 'doc') await api.knowledge.docs.restore(item.id);
        else await api.knowledge.files.restore(item.id);
      },
      onSettled: (_data, _error, item) => (item.type === 'doc' ? settleDoc(item.id) : settle()),
    }),
    share: useMutation({
      mutationFn: ({ type, id, input }: { type: 'folder' | 'doc'; id: string; input: ShareInput }) =>
        type === 'folder' ? api.knowledge.folders.share(id, input) : api.knowledge.docs.share(id, input),
      onSuccess: (shares, { type, id }) => client.setQueryData(keys.knowledgeShares(type, id), shares),
      onSettled: (_data, _error, { type, id }) => (type === 'doc' ? settleDoc(id) : settle()),
    }),
  };
}

/** Exports (KNOW-12): a doc as Markdown, a folder or a whole space as a ZIP. */
export async function exportKnowledge(
  target: { type: 'doc'; id: string } | { type: 'folder'; id: string } | { type: 'space'; space: KnowledgeSpace },
) {
  if (target.type === 'doc') {
    const { filename, markdown } = await api.knowledge.docs.export(target.id);
    return saveBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), filename);
  }
  const { filename, blob } =
    target.type === 'folder'
      ? await api.knowledge.folders.export(target.id)
      : await api.knowledge.exportSpace(target.space);
  saveBlob(blob, filename);
}
