/**
 * KB folder path helpers — translate between "指南/场景示例" style paths and
 * `folders` rows (scope='kb') for the knowledge agent tools.
 *
 * Resolution is scoped the same way routes/knowledge.ts#validateFolderTarget
 * guards moves: team docs only see team folders, personal docs only see the
 * owner's private folders — so a doc can never be filed into a folder its
 * visibility disallows.
 */

import type { DatabaseProvider, DriveFolderRow } from '@greenhouse/db';
import { shelfOfVisibility } from '@greenhouse/types/files';
import { createCabinetFolder, type CabinetCaller } from '../drive/kb-cabinet.js';

/** Guard against a cycle in drive_folders turning a walk into a hang. */
const MAX_TREE_DEPTH = 16;

export interface KbFolderScope {
  visibility: 'team' | 'private';
  /** Required when visibility is 'private' (the folder owner). */
  ownerUserId?: string;
}

export type KbFolderResolution =
  | {
      ok: true;
      folderId: string | null;
      path: string;
      /** Paths of the folders this call created (only with `create`). */
      created?: string[];
    }
  | { ok: false; error: string };

/**
 * Resolve a slash-separated folder path to a folder id. "" or "/" resolves to
 * the root (folderId null). By default folders must already exist — a miss
 * returns an error that lists the siblings at the failed level so the model can
 * correct itself instead of guessing.
 *
 * With `create`, each missing segment is created through the Files cabinet's
 * own `createCabinetFolder` (same drive access rule, same name rules, same
 * audit row as `files_mutation` folders.create and the browser). A caller can
 * only ever create on its own shelves: team folders, or its OWN personal tree —
 * resolving into another member's private tree (an editor filing a doc shared
 * with them) never creates anything there.
 */
export async function resolveKbFolderPath(
  db: DatabaseProvider,
  path: string,
  scope: KbFolderScope,
  opts: { create?: CabinetCaller } = {},
): Promise<KbFolderResolution> {
  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return { ok: true, folderId: null, path: '/' };
  if (opts.create && segments.length > MAX_TREE_DEPTH) {
    return { ok: false, error: `Folder path is deeper than ${MAX_TREE_DEPTH} levels.` };
  }

  let parentId: string | null = null;
  const resolved: string[] = [];
  const created: string[] = [];
  for (const name of segments) {
    // Below a folder this call just created there is nothing to list.
    const siblings: DriveFolderRow[] = created.length
      ? []
      : await db.drive.listFolders({
          scope: 'kb',
          parent_id: parentId,
          visibility: scope.visibility,
          owner_user_id: scope.visibility === 'private' ? scope.ownerUserId : undefined,
        });
    const matches = siblings.filter((f) => f.name === name);
    if (matches.length === 0 && opts.create) {
      const caller = opts.create;
      if (scope.visibility === 'private' && scope.ownerUserId !== caller.userId) {
        return {
          ok: false,
          error: `Folder not found: "${name}". Folders can only be created in your own personal tree, not in the document owner's — pick an existing folder.`,
        };
      }
      const made = await createCabinetFolder(caller, {
        shelf: shelfOfVisibility(scope.visibility),
        parentId,
        name,
      });
      if ('error' in made) return { ok: false, error: `Could not create folder "${name}": ${made.error}` };
      parentId = made.folder.id;
      resolved.push(made.folder.name);
      created.push(resolved.join('/'));
      continue;
    }
    if (matches.length === 0) {
      const where = resolved.length ? `under "${resolved.join('/')}"` : 'at the root';
      const available = siblings.map((f) => f.name).join(', ') || '(none)';
      return {
        ok: false,
        error: `Folder not found: "${name}" ${where}. Available folders: ${available}`,
      };
    }
    if (matches.length > 1) {
      const where = resolved.length ? `under "${resolved.join('/')}"` : 'at the root';
      return {
        ok: false,
        error: `Folder name "${name}" is ambiguous ${where} (${matches.length} folders share it) — rename one in the sidebar first`,
      };
    }
    parentId = matches[0].id;
    resolved.push(name);
  }
  return {
    ok: true,
    folderId: parentId,
    path: resolved.join('/'),
    ...(created.length ? { created } : {}),
  };
}

/** Render a folder id back into its "a/b/c" path (for tool output). */
export async function kbFolderPath(db: DatabaseProvider, folderId: string): Promise<string> {
  const chain = await db.drive.breadcrumb(folderId);
  return chain.map((f) => f.name).join('/');
}

/**
 * Resolve several folder ids to paths in one pass, memoised per call — search
 * and list results routinely share folders, and breadcrumb() is a query each.
 */
export async function kbFolderPaths(db: DatabaseProvider, folderIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(folderIds)) {
    out.set(id, await kbFolderPath(db, id));
  }
  return out;
}

/**
 * Every folder id in a subtree, root included — the expansion behind the
 * `folder` filter on search/list. Kept in the app layer rather than a recursive
 * CTE: KB trees are shallow and small, and the read path stays a plain
 * `folder_id IN (…)`.
 */
export async function kbFolderSubtreeIds(
  db: DatabaseProvider,
  rootId: string,
  scope: KbFolderScope,
): Promise<string[]> {
  const ids = [rootId];
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const children = await db.drive.listFolders({
        scope: 'kb',
        parent_id: parentId,
        visibility: scope.visibility,
        owner_user_id: scope.visibility === 'private' ? scope.ownerUserId : undefined,
      });
      for (const child of children) {
        if (ids.includes(child.id)) continue;
        ids.push(child.id);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return ids;
}

export interface KbTreeFolder {
  /** "a/b/c"; "/" is the root. */
  path: string;
  docs: Array<{ id: string; title: string }>;
}

/**
 * The folder tree with the documents filed in each folder — the `ls` the agent
 * read path was missing. Folders the caller may not see are never walked: the
 * scope decides which tree exists at all (team docs live in team folders,
 * personal docs in the owner's own), exactly as `resolveKbFolderPath` does.
 */
export async function kbTree(
  db: DatabaseProvider,
  scope: KbFolderScope,
  opts: { rootId?: string | null; docLimit: number },
): Promise<{ folders: KbTreeFolder[]; total_docs: number; truncated: boolean }> {
  // One flat pass over the folders, so a doc's path is a lookup rather than a
  // breadcrumb query per document.
  const pathById = new Map<string, string>();
  const rootId = opts.rootId ?? null;
  const rootPath = rootId == null ? '' : await kbFolderPath(db, rootId);

  let frontier: Array<{ id: string | null; path: string }> = [{ id: rootId, path: rootPath }];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: Array<{ id: string | null; path: string }> = [];
    for (const node of frontier) {
      const children = await db.drive.listFolders({
        scope: 'kb',
        parent_id: node.id,
        visibility: scope.visibility,
        owner_user_id: scope.visibility === 'private' ? scope.ownerUserId : undefined,
      });
      for (const child of children) {
        if (pathById.has(child.id)) continue;
        const path = node.path ? `${node.path}/${child.name}` : child.name;
        pathById.set(child.id, path);
        next.push({ id: child.id, path });
      }
    }
    frontier = next;
  }

  const docs = await db.knowledgeBase.list({
    scope: 'shared',
    status: 'published',
    visibility: scope.visibility,
    ownerUserId: scope.visibility === 'private' ? scope.ownerUserId : undefined,
    // Restricting to the subtree also drops root-level docs when a root is given.
    folderIds: rootId == null ? undefined : [rootId, ...pathById.keys()],
    limit: opts.docLimit + 1,
  });
  const truncated = docs.length > opts.docLimit;
  const shown = truncated ? docs.slice(0, opts.docLimit) : docs;

  const byPath = new Map<string, KbTreeFolder>();
  // Seed every folder so empty ones stay visible — "this column exists but has
  // nothing in it yet" is a real answer.
  const seedPath = rootId == null ? '/' : rootPath;
  byPath.set(seedPath, { path: seedPath, docs: [] });
  for (const path of pathById.values()) byPath.set(path, { path, docs: [] });

  for (const doc of shown) {
    const path = doc.folder_id == null ? seedPath : (pathById.get(doc.folder_id) ?? seedPath);
    byPath.get(path)?.docs.push({ id: doc.id, title: doc.title });
  }

  return {
    folders: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    total_docs: shown.length,
    truncated,
  };
}

export interface KbFolderNode {
  id: string;
  /** "a/b/c" from the scope root. */
  path: string;
  /** 1 = a direct child of the listing root. */
  depth: number;
  /** Non-archived documents filed directly in this folder. */
  docs: number;
  /** Subfolders not listed because of `maxDepth` (only on nodes at the depth limit). */
  more_subfolders?: number;
}

/**
 * The folder tree alone — ids, paths and doc counts, no document titles — for
 * deciding where to file something or what `create_folders` would add. One
 * query for the whole scope (the caller's visible tree is filtered in SQL by
 * visibility + owner, exactly like `resolveKbFolderPath`), walked in memory
 * breadth-first so a node cap keeps the shallow levels, then one count per
 * listed folder. Bounded by `maxDepth` and `maxNodes`; `truncated` says so.
 */
export async function kbFolderTree(
  db: DatabaseProvider,
  scope: KbFolderScope,
  opts: { rootId?: string | null; maxDepth: number; maxNodes: number },
): Promise<{ folders: KbFolderNode[]; total_folders: number; truncated: boolean }> {
  const all = await db.drive.listFolders({
    scope: 'kb',
    visibility: scope.visibility,
    owner_user_id: scope.visibility === 'private' ? scope.ownerUserId : undefined,
  });
  // listFolders orders by (sort_order, name), so children keep the sidebar order.
  const children = new Map<string | null, typeof all>();
  for (const folder of all) {
    const list = children.get(folder.parent_id) ?? [];
    list.push(folder);
    children.set(folder.parent_id, list);
  }

  const rootId = opts.rootId ?? null;
  const rootPath = rootId == null ? '' : await kbFolderPath(db, rootId);
  const nodes: Array<Omit<KbFolderNode, 'docs'>> = [];
  const seen = new Set<string>();
  // Walk the whole subtree (it is already in memory) so `total_folders` is the
  // real size; only the first `maxNodes` within `maxDepth` are listed.
  let reachable = 0;
  let frontier: Array<{ id: string | null; path: string }> = [{ id: rootId, path: rootPath }];
  for (let depth = 1; frontier.length > 0 && depth <= MAX_TREE_DEPTH; depth++) {
    const next: Array<{ id: string | null; path: string }> = [];
    for (const parent of frontier) {
      for (const child of children.get(parent.id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        reachable++;
        const path = parent.path ? `${parent.path}/${child.name}` : child.name;
        next.push({ id: child.id, path });
        if (depth > opts.maxDepth || nodes.length >= opts.maxNodes) continue;
        const hidden = depth === opts.maxDepth ? (children.get(child.id)?.length ?? 0) : 0;
        nodes.push({ id: child.id, path, depth, ...(hidden ? { more_subfolders: hidden } : {}) });
      }
    }
    frontier = next;
  }

  // Breadth-first picks which folders fit; path order makes the listing read as a tree.
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  const folders: KbFolderNode[] = [];
  for (const node of nodes) folders.push({ ...node, docs: await db.knowledgeBase.countInFolder(node.id) });
  return { folders, total_folders: reachable, truncated: reachable > nodes.length };
}
