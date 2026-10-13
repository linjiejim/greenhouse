/**
 * Exports (KNOW-12): a folder or a whole space as a ZIP that mirrors the tree. One directory per
 * folder, one `<title>.md` per doc with a short front matter, the folder's files next to them,
 * and files the docs show under `assets/`. Links between exported docs and to exported files
 * become relative paths, so the archive reads offline. Nothing is skipped silently: what was
 * left out is listed in EXPORT-NOTES.md.
 */

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { fileLinkIds, replaceDocLinks, replaceFileLinks } from './markdown.js';

export const MAX_EXPORT_DOCS = 5_000;
/** Files and pictures together; past this they are listed instead of packed. */
export const MAX_EXPORT_FILE_BYTES = 1024 * 1024 * 1024;
/** Directory nesting kept in paths; deeper folders are flattened into the last level. */
const MAX_DEPTH = 32;

export interface ExportFolder {
  id: string;
  parentId: string | null;
  name: string;
}
export interface ExportDoc {
  id: string;
  folderId: string | null;
  title: string;
  content: string;
  version: number;
  updatedAt: string;
}
export interface ExportFile {
  id: string;
  folderId: string | null;
  name: string;
  sizeBytes: number;
}

export interface ExportInput {
  /** The folder being exported (its contents become the archive root); null for a whole space. */
  rootId: string | null;
  folders: ExportFolder[];
  docs: ExportDoc[];
  /** Files in the tree. */
  files: ExportFile[];
  /** Other files the docs show that the reader may open (pictures pasted into docs). */
  assets: ExportFile[];
  locale: 'zh' | 'en';
  label: string;
  exportedAt: string;
}

export type ExportEntry = { path: string; text: string } | { path: string; fileId: string; sizeBytes: number };

/**
 * One path segment that every system accepts: no separators or control characters, no trailing
 * dots or spaces, at most 80 characters. Chinese stays as it is.
 */
export function safeSegment(name: string, fallback: string): string {
  const cleaned = [...name]
    .map((char) =>
      char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f || '\\/:*?"<>|'.includes(char) ? '-' : char,
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

/** A path from one directory to another file, for a Markdown link. */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const target = to.split('/');
  let shared = 0;
  while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) shared++;
  const path = [...from.slice(shared).map(() => '..'), ...target.slice(shared)].join('/');
  return /[\s()<>]/.test(path) ? `<${path}>` : path;
}

const COPY = {
  zh: {
    title: '# Greenhouse 知识库导出',
    exported: '导出时间',
    scope: '范围',
    counts: (docs: number, folders: number, files: number) =>
      `文档 ${docs} 篇 · 文件夹 ${folders} 个 · 文件 ${files} 个`,
    about:
      '目录结构与知识库一致：每篇文档是一个 `.md` 文件，顶部记录了标题、编号和版本；文档里的图片在 `assets/`。这是导出时的快照，之后的修改不会出现在这里。',
    notesTitle: '# 导出说明',
    notesIntro: '以下内容没有完整打包：',
    tooManyDocs: (limit: number) => `文档超过 ${limit} 篇，其余没有导出。`,
    tooBig: (name: string) => `文件总量超过上限，没有打包：${name}`,
    missing: (name: string) => `存储里找不到这个文件：${name}`,
    unreadable: (doc: string) => `《${doc}》引用的文件你无法打开，保留了原链接。`,
  },
  en: {
    title: '# Greenhouse knowledge export',
    exported: 'Exported',
    scope: 'Scope',
    counts: (docs: number, folders: number, files: number) => `${docs} docs · ${folders} folders · ${files} files`,
    about:
      'The folders mirror the knowledge base: each doc is a `.md` file whose front matter has its title, id and version; pictures in docs are under `assets/`. This is a snapshot: later changes are not in it.',
    notesTitle: '# Export notes',
    notesIntro: 'These were not packed in full:',
    tooManyDocs: (limit: number) => `More than ${limit} docs: the rest were left out.`,
    tooBig: (name: string) => `Over the size limit, not packed: ${name}`,
    missing: (name: string) => `Not found in storage: ${name}`,
    unreadable: (doc: string) => `"${doc}" shows a file you cannot open; its link was kept.`,
  },
} as const;

export function exportCopy(locale: 'zh' | 'en') {
  return COPY[locale];
}

/** Where everything goes in the archive, and the Markdown of each doc with its links rewritten. */
export function planExport(input: ExportInput): { entries: ExportEntry[]; notes: string[] } {
  const copy = COPY[input.locale];
  const notes: string[] = [];
  const byId = new Map(input.folders.map((folder) => [folder.id, folder]));
  /** Names taken in each directory (case-insensitive: some systems are). */
  const taken = new Map<string, Set<string>>();
  const claim = (dir: string, name: string) => {
    const names = taken.get(dir) ?? new Set<string>();
    taken.set(dir, names);
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = name;
    for (let n = 2; names.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${extension}`;
    names.add(candidate.toLowerCase());
    return dir ? `${dir}/${candidate}` : candidate;
  };

  const assetIds = new Set(input.assets.map((file) => file.id));
  // The archive's own names at the root come first.
  claim('', 'README.md');
  claim('', 'EXPORT-NOTES.md');
  if (assetIds.size) claim('', 'assets');

  const dirs = new Map<string, string>();
  const dirOf = (folderId: string | null, depth = 0): string => {
    if (!folderId || folderId === input.rootId) return '';
    const cached = dirs.get(folderId);
    if (cached !== undefined) return cached;
    const folder = byId.get(folderId);
    if (!folder) return '';
    const parent = depth >= MAX_DEPTH ? '' : dirOf(folder.parentId, depth + 1);
    const path = claim(parent, safeSegment(folder.name, 'folder'));
    dirs.set(folderId, path);
    return path;
  };
  // Folders in order so siblings keep stable names; parents resolve before children.
  for (const folder of input.folders) if (folder.id !== input.rootId) dirOf(folder.id);

  let docs = input.docs;
  if (docs.length > MAX_EXPORT_DOCS) {
    notes.push(copy.tooManyDocs(MAX_EXPORT_DOCS));
    docs = docs.slice(0, MAX_EXPORT_DOCS);
  }

  const docPaths = new Map<string, string>();
  for (const doc of docs) docPaths.set(doc.id, claim(dirOf(doc.folderId), `${safeSegment(doc.title, 'doc')}.md`));

  let bytes = 0;
  const filePaths = new Map<string, string>();
  const entries: ExportEntry[] = [];
  const pack = (file: ExportFile, dir: string) => {
    if (bytes + file.sizeBytes > MAX_EXPORT_FILE_BYTES) {
      notes.push(copy.tooBig(file.name));
      return;
    }
    bytes += file.sizeBytes;
    const path = claim(dir, safeSegment(file.name, 'file'));
    filePaths.set(file.id, path);
    entries.push({ path, fileId: file.id, sizeBytes: file.sizeBytes });
  };
  for (const file of input.files) pack(file, dirOf(file.folderId));
  for (const file of input.assets) if (!filePaths.has(file.id)) pack(file, 'assets');

  for (const doc of docs) {
    const path = docPaths.get(doc.id)!;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const missing = fileLinkIds(doc.content).some((id) => !filePaths.has(id));
    if (missing) notes.push(copy.unreadable(doc.title));
    let body = replaceFileLinks(doc.content, (id) => {
      const target = filePaths.get(id);
      return target ? relativePath(dir, target) : null;
    });
    body = replaceDocLinks(body, (id) => {
      const target = docPaths.get(id);
      return target ? relativePath(dir, target) : null;
    });
    const front = [
      '---',
      `title: ${JSON.stringify(doc.title)}`,
      `id: ${doc.id}`,
      `version: ${doc.version}`,
      `updated_at: ${doc.updatedAt}`,
      '---',
      '',
    ].join('\n');
    entries.push({ path, text: `${front}${body.endsWith('\n') || !body ? body : `${body}\n`}` });
  }

  const readme = [
    copy.title,
    '',
    `- ${copy.exported}: ${input.exportedAt}`,
    `- ${copy.scope}: ${input.label}`,
    `- ${copy.counts(docs.length, dirs.size, filePaths.size)}`,
    '',
    copy.about,
    '',
  ].join('\n');
  entries.unshift({ path: 'README.md', text: readme });
  return { entries, notes };
}

/** The notes file, when anything was left out. */
export function notesEntry(locale: 'zh' | 'en', notes: readonly string[]): ExportEntry | null {
  if (!notes.length) return null;
  const copy = COPY[locale];
  return {
    path: 'EXPORT-NOTES.md',
    text: [copy.notesTitle, '', copy.notesIntro, '', ...notes.map((note) => `- ${note}`), ''].join('\n'),
  };
}

export interface ZipWriter {
  /** A text file, compressed. */
  text(path: string, text: string): Promise<void>;
  /** Bytes from a stream, stored as they are (most files are compressed already). */
  stream(path: string, body: ReadableStream<Uint8Array>): Promise<void>;
}

const HIGH_WATER = 8 * 1024 * 1024;

/**
 * A ZIP written while it is read: `produce` adds the entries one after another and waits when
 * the reader falls behind. A reader that goes away stops it.
 */
export function zipStream(produce: (zip: ZipWriter) => Promise<void>): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = [];
  let queued = 0;
  let finished = false;
  let failure: unknown = null;
  let cancelled = false;
  let wakeReader: (() => void) | null = null;
  let wakeWriter: (() => void) | null = null;
  const signalReader = () => {
    wakeReader?.();
    wakeReader = null;
  };

  const archive = new Zip((error, chunk, final) => {
    if (error) failure = error;
    else if (chunk.length) {
      queue.push(chunk);
      queued += chunk.length;
    }
    if (final) finished = true;
    signalReader();
  });

  /** Waits while the reader is far behind. */
  async function room() {
    while (queued > HIGH_WATER && !cancelled) await new Promise<void>((resolve) => (wakeWriter = resolve));
    if (cancelled) throw new Error('The download was cancelled.');
  }

  const writer: ZipWriter = {
    async text(path, text) {
      await room();
      const entry = new ZipDeflate(path, { level: 6 });
      archive.add(entry);
      entry.push(new TextEncoder().encode(text), true);
    },
    async stream(path, body) {
      const entry = new ZipPassThrough(path);
      archive.add(entry);
      const reader = body.getReader();
      try {
        for (;;) {
          await room();
          const { done, value } = await reader.read();
          if (done) break;
          entry.push(value, false);
        }
        entry.push(new Uint8Array(0), true);
      } finally {
        reader.releaseLock();
      }
    },
  };

  void produce(writer)
    .then(() => archive.end())
    .catch((error: unknown) => {
      failure = error;
      signalReader();
    });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!queue.length && !finished && !failure) await new Promise<void>((resolve) => (wakeReader = resolve));
      if (failure) return controller.error(failure);
      const chunk = queue.shift();
      if (chunk) {
        queued -= chunk.length;
        if (queued <= HIGH_WATER) {
          wakeWriter?.();
          wakeWriter = null;
        }
        controller.enqueue(chunk);
      } else controller.close();
    },
    cancel() {
      cancelled = true;
      wakeWriter?.();
      wakeWriter = null;
      archive.terminate();
    },
  });
}
