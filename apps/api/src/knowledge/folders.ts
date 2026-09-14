/**
 * KB folder path helpers — translate between "指南/场景示例" style paths and
 * drive_folders rows (scope='kb') for the knowledge agent tools.
 *
 * Resolution is scoped the same way routes/knowledge.ts#validateFolderTarget
 * guards moves: team docs only see team folders, personal docs only see the
 * owner's private folders — so a doc can never be filed into a folder its
 * visibility disallows.
 */

import type { DatabaseProvider } from '@greenhouse/db';

export interface KbFolderScope {
  visibility: 'team' | 'private';
  /** Required when visibility is 'private' (the folder owner). */
  ownerUserId?: string;
}

export type KbFolderResolution = { ok: true; folderId: number | null; path: string } | { ok: false; error: string };

/**
 * Resolve a slash-separated folder path to a folder id. "" or "/" resolves to
 * the root (folderId null). Folders must already exist — a miss returns an
 * error that lists the siblings at the failed level so the model can correct
 * itself instead of guessing.
 */
export async function resolveKbFolderPath(
  db: DatabaseProvider,
  path: string,
  scope: KbFolderScope,
): Promise<KbFolderResolution> {
  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return { ok: true, folderId: null, path: '/' };

  let parentId: number | null = null;
  const resolved: string[] = [];
  for (const name of segments) {
    const siblings = await db.drive.listFolders({
      scope: 'kb',
      parent_id: parentId,
      visibility: scope.visibility,
      owner_user_id: scope.visibility === 'private' ? scope.ownerUserId : undefined,
    });
    const matches = siblings.filter((f) => f.name === name);
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
  return { ok: true, folderId: parentId, path: resolved.join('/') };
}

/** Render a folder id back into its "a/b/c" path (for tool output). */
export async function kbFolderPath(db: DatabaseProvider, folderId: number): Promise<string> {
  const chain = await db.drive.breadcrumb(folderId);
  return chain.map((f) => f.name).join('/');
}

/**
 * Resolve several folder ids to paths in one pass, memoised per call — search
 * and list results routinely share folders, and breadcrumb() is a query each.
 */
export async function kbFolderPaths(db: DatabaseProvider, folderIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const id of new Set(folderIds)) {
    out.set(id, await kbFolderPath(db, id));
  }
  return out;
}

/** Guard against a cycle in drive_folders turning a walk into a hang. */
const MAX_TREE_DEPTH = 16;

/**
 * Every folder id in a subtree, root included — the expansion behind the
 * `folder` filter on search/list. Kept in the app layer rather than a recursive
 * CTE: KB trees are shallow and small, and the read path stays a plain
 * `folder_id IN (…)`.
 */
export async function kbFolderSubtreeIds(
  db: DatabaseProvider,
  rootId: number,
  scope: KbFolderScope,
): Promise<number[]> {
  const ids = [rootId];
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];
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
  docs: Array<{ id: number; title: string }>;
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
  opts: { rootId?: number | null; docLimit: number },
): Promise<{ folders: KbTreeFolder[]; total_docs: number; truncated: boolean }> {
  // One flat pass over the folders, so a doc's path is a lookup rather than a
  // breadcrumb query per document.
  const pathById = new Map<number, string>();
  const rootId = opts.rootId ?? null;
  const rootPath = rootId == null ? '' : await kbFolderPath(db, rootId);

  let frontier: Array<{ id: number | null; path: string }> = [{ id: rootId, path: rootPath }];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: Array<{ id: number | null; path: string }> = [];
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
