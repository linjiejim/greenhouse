/**
 * Whole-KB Markdown export — the inverse of `cli knowledge import-*`.
 *
 * Produces a self-contained zip that mirrors the sidebar tree: one directory per
 * kb folder, one `<title>.md` per doc, embedded `/api/upload/<id>` images pulled
 * into `assets/` with the links rewritten to relative paths. Round-tripping is
 * the design goal — `importSeedTree()` defines the folder↔directory mapping and
 * this reverses it, so an export can be edited and re-imported.
 *
 * SCOPE IS PINNED TO TEAM DOCS, deliberately. `db.knowledgeBase.listAll()` is one
 * call away and would sweep every user's private notes into an admin's download;
 * "the whole knowledge base" means the internal team library, and personal docs
 * are not part of it at any role (the HTTP list endpoint draws the same line —
 * super sees no more than anyone else).
 *
 * No silent caps: anything skipped (missing image bytes, a doc past the ceiling)
 * is written into EXPORT-NOTES.md inside the archive.
 */

import { zipSync, type Zippable } from 'fflate';
import type { DatabaseProvider, DriveFolderRow, KnowledgeDocRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getUpload } from '../storage/uploads.js';

/** Hard ceiling on exported docs; a bigger library needs a streaming design. */
const MAX_DOCS = 2000;
/** Hard ceiling on bytes pulled in for images, so one export can't eat the heap. */
const MAX_ASSET_BYTES = 300 * 1024 * 1024;
/** Depth guard for the parent walk (a corrupt cycle must not hang the request). */
const MAX_FOLDER_DEPTH = 32;

/** Any `/api/upload/<id>` reference in Markdown; ids are flat and unpadded. */
const UPLOAD_REF = /\/api\/upload\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export interface KnowledgeExportResult {
  bytes: Uint8Array;
  filename: string;
  stats: { docs: number; folders: number; assets: number; notes: string[] };
}

/**
 * What to pack. Omit both for the whole team library; `folderId` takes that
 * folder plus its whole subtree (the folder itself becomes the archive root),
 * `docId` takes one document. Scoping is about download size, not permission —
 * the visibility filter below applies identically in all three cases.
 */
export interface KnowledgeExportScope {
  folderId?: number;
  docId?: number;
}

/**
 * Make one path segment safe on every OS: no separators, no control characters,
 * no trailing dots/spaces (Windows), bounded length. CJK is preserved — a
 * readable archive is the point, and zip filenames are UTF-8.
 */
export function safeSegment(name: string, fallback: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** Resolve each folder id to its slash path, deduplicating sibling name clashes. */
function folderPaths(folders: DriveFolderRow[]): Map<number, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<number, string>();
  const takenPerParent = new Map<string, Set<string>>();

  const segmentFor = (folder: DriveFolderRow): string => {
    const key = String(folder.parent_id ?? 'root');
    const taken = takenPerParent.get(key) ?? new Set<string>();
    takenPerParent.set(key, taken);
    const base = safeSegment(folder.name, `folder-${folder.id}`);
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base} (${n})`;
    taken.add(candidate);
    return candidate;
  };

  // Parents before children: walk the chain per folder, memoizing as we go.
  const resolve = (folder: DriveFolderRow, depth = 0): string => {
    const cached = paths.get(folder.id);
    if (cached !== undefined) return cached;
    if (depth >= MAX_FOLDER_DEPTH) return segmentFor(folder);
    const parent = folder.parent_id != null ? byId.get(folder.parent_id) : undefined;
    const prefix = parent ? `${resolve(parent, depth + 1)}/` : '';
    const path = `${prefix}${segmentFor(folder)}`;
    paths.set(folder.id, path);
    return path;
  };

  for (const folder of folders) resolve(folder);
  return paths;
}

/** Folder id plus every folder beneath it (bounded sweep, cycle-safe). */
function subtreeFolderIds(folders: DriveFolderRow[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId]);
  for (let i = 0; i < MAX_FOLDER_DEPTH; i++) {
    const before = ids.size;
    for (const f of folders) if (f.parent_id != null && ids.has(f.parent_id)) ids.add(f.id);
    if (ids.size === before) break;
  }
  return ids;
}

/** Assemble the archive. Caller owns authorization (super-only at the route). */
export async function buildKnowledgeExport(
  db: DatabaseProvider,
  exportedAt: string,
  scope: KnowledgeExportScope = {},
): Promise<KnowledgeExportResult> {
  const notes: string[] = [];

  let docs: KnowledgeDocRow[] = await db.knowledgeBase.list({
    scope: 'shared',
    visibility: 'team',
    status: 'published',
    limit: MAX_DOCS,
  });
  if (docs.length >= MAX_DOCS) {
    notes.push(`达到导出上限 ${MAX_DOCS} 篇，更多文档未包含在本压缩包内。`);
  }

  let folders = await db.drive.listFolders({ scope: 'kb', visibility: 'team' });
  let label = '知识库';

  if (scope.docId != null) {
    docs = docs.filter((d) => d.id === scope.docId);
    label = docs[0] ? safeSegment(docs[0].title, '文档') : '文档';
    // A single doc is packed flat: its folder chain would be empty directories.
    folders = [];
    docs = docs.map((d) => ({ ...d, folder_id: null }));
  } else if (scope.folderId != null) {
    const root = folders.find((f) => f.id === scope.folderId);
    const wanted = root ? subtreeFolderIds(folders, root.id) : new Set<number>();
    folders = folders.filter((f) => wanted.has(f.id));
    docs = docs.filter((d) => d.folder_id != null && wanted.has(d.folder_id));
    label = root ? safeSegment(root.name, '目录') : '目录';
    // Re-root the subtree so the archive opens on the folder itself, not on a
    // chain of empty ancestors.
    if (root) folders = folders.map((f) => (f.id === root.id ? { ...f, parent_id: null } : f));
  }

  const paths = folderPaths(folders);

  // Doc file names, deduplicated within their directory.
  const takenPerDir = new Map<string, Set<string>>();
  const fileNameFor = (doc: KnowledgeDocRow, dir: string): string => {
    const taken = takenPerDir.get(dir) ?? new Set<string>();
    takenPerDir.set(dir, taken);
    const base = safeSegment(doc.title, doc.doc_id.replace(/\//g, '-') || `doc-${doc.id}`);
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base} (${n})`;
    taken.add(candidate);
    return `${candidate}.md`;
  };

  const files: Zippable = {};
  const assetIds = new Set<string>();

  for (const doc of docs) {
    const dir = doc.folder_id != null ? (paths.get(doc.folder_id) ?? '') : '';
    const depth = dir ? dir.split('/').length : 0;
    // Links are relative to the doc, so the archive works when opened in place.
    const assetPrefix = `${'../'.repeat(depth)}assets/`;
    const body = doc.content.replace(UPLOAD_REF, (_m, id: string) => {
      assetIds.add(id);
      return `${assetPrefix}${id}`;
    });

    const front = [
      '---',
      `doc_id: ${doc.doc_id}`,
      `title: ${JSON.stringify(doc.title)}`,
      `updated_at: ${doc.updated_at ?? ''}`,
      '---',
      '',
    ].join('\n');
    files[`${dir ? `${dir}/` : ''}${fileNameFor(doc, dir)}`] = new TextEncoder().encode(front + body);
  }

  // Pull image bytes. A miss is reported, never silently dropped: the doc keeps
  // its relative link and the notes say which file is absent.
  let assetBytes = 0;
  let assets = 0;
  for (const id of assetIds) {
    if (assetBytes >= MAX_ASSET_BYTES) {
      notes.push(`图片总量超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB，其余图片未打包。`);
      break;
    }
    try {
      const object = await getUpload(id);
      if (!object) {
        notes.push(`图片缺失（存储里找不到）：assets/${id}`);
        continue;
      }
      // level 0: PNG/JPEG are already compressed, deflating them again only burns CPU.
      files[`assets/${id}`] = [new Uint8Array(object.buffer), { level: 0 }];
      assetBytes += object.buffer.length;
      assets += 1;
    } catch (err) {
      notes.push(`图片读取失败：assets/${id} — ${toErrorMessage(err)}`);
      logger.warn('[knowledge-export] asset read failed', { id, error: toErrorMessage(err) });
    }
  }

  const scopeLine =
    scope.docId != null
      ? `- 范围：单篇文档《${label}》`
      : scope.folderId != null
        ? `- 范围：目录「${label}」及其子目录`
        : '- 范围：内部知识库全部（团队可见、已发布）';
  const readme = [
    '# Greenhouse 知识库导出',
    '',
    `- 导出时间：${exportedAt}`,
    scopeLine,
    `- 内容一律限于团队可见、已发布的文档——**不含任何人的个人文档**`,
    `- 文档 ${docs.length} 篇 · 目录 ${folders.length} 个 · 图片 ${assets} 张`,
    '',
    '目录结构与知识库侧栏一致，每篇文档是一个 `.md` 文件，正文顶部的 front matter 记录了',
    '原始 `doc_id`（重新导入时按它匹配）。文中的图片指向压缩包内的 `assets/`，',
    '可直接用任何 Markdown 编辑器打开阅读。',
    '',
    '知识库本身仍是真源：这份导出是某一时刻的快照，不会随后续编辑更新。',
    '',
  ].join('\n');
  files['README.md'] = new TextEncoder().encode(readme);
  if (notes.length > 0) {
    files['EXPORT-NOTES.md'] = new TextEncoder().encode(
      ['# 导出说明', '', '本次导出有以下未完整包含的内容：', '', ...notes.map((n) => `- ${n}`), ''].join('\n'),
    );
  }

  // Images are already compressed; only the Markdown is worth deflating.
  const bytes = zipSync(files, { level: 6 });
  const day = exportedAt.slice(0, 10);
  return {
    bytes,
    filename: `greenhouse-${label}-${day}.zip`,
    stats: { docs: docs.length, folders: folders.length, assets, notes },
  };
}
