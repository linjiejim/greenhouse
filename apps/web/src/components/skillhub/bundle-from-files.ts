/**
 * Browser-side bundle assembly for the SkillHub upload dialog — turn dropped
 * files (a .zip, a bare SKILL.md, or a multi-file selection) into the
 * `files[]` payload `POST /api/skills/publish` already accepts.
 *
 * Pure functions over bytes so they can be unit-tested without a DOM.
 *
 * Why the zip is unpacked HERE (spec D4): the publish contract is already a
 * file list, so the client-side path adds one 8 KB dependency (fflate) and no
 * server surface. Unpacking on the server instead would mean a new multipart
 * route, a new server dependency, and accepting untrusted archives into the
 * API process (zip-slip / zip-bomb) for no gain. Hand-rolling a central
 * directory parser over DecompressionStream was rejected too — ~120 lines of
 * bespoke parsing of untrusted input is exactly the code you don't write.
 *
 * The size/count/path checks below are NOT a security boundary — the server
 * re-validates every one of them in skills/bundle.ts. They exist so a user
 * learns their bundle is too big before hitting Submit. The parity test
 * (tests/skillhub/upload-limits-parity.test.ts) pins the two sets of limits
 * together so they cannot drift.
 */

import { unzipSync } from 'fflate';

export const MAX_FILES = 64;
export const MAX_BUNDLE_BYTES = 1024 * 1024; // 1 MiB decoded
export const MAX_PATH_LENGTH = 200;
export const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Extensions stored as utf8 text; everything else is base64'd. Mirrors boot-seed's table. */
const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'svg',
  'html',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'json',
  'yml',
  'yaml',
  'xml',
  'csv',
]);

export interface BundleFile {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

/** A raw input entry — one dropped file, or one member of a zip. */
export interface RawEntry {
  path: string;
  bytes: Uint8Array;
}

export type BundleResult = { ok: true; files: BundleFile[]; sizeBytes: number } | { ok: false; error: string };

/** Archive-manager noise that must never reach the bundle. */
function isJunk(path: string): boolean {
  const segments = path.split('/');
  return segments.some((s) => s === '__MACOSX' || s === '.DS_Store' || s === 'Thumbs.db' || s.startsWith('._'));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to stay clear of the argument-count limit on large assets.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Drop a single shared top-level directory. Zipping a `my-skill/` folder is the
 * normal way to produce one of these, and the resulting `my-skill/SKILL.md`
 * would otherwise fail the "SKILL.md at the root" rule.
 */
export function stripCommonRoot(paths: string[]): string {
  if (paths.length === 0) return '';
  const first = paths[0]!.split('/');
  if (first.length < 2) return '';
  const root = `${first[0]}/`;
  return paths.every((p) => p.startsWith(root)) ? root : '';
}

/** Expand a .zip into raw entries (directories and junk removed). */
export function entriesFromZip(bytes: Uint8Array): RawEntry[] {
  const unzipped = unzipSync(bytes);
  const entries: RawEntry[] = [];
  for (const [path, data] of Object.entries(unzipped)) {
    if (path.endsWith('/')) continue; // directory record
    if (isJunk(path)) continue;
    entries.push({ path, bytes: data });
  }
  return entries;
}

function validatePath(path: string): string | null {
  if (path.length > MAX_PATH_LENGTH) return `Path too long (max ${MAX_PATH_LENGTH}): "${path.slice(0, 50)}…"`;
  if (path.includes('\\')) return `Use "/" as the path separator: "${path}"`;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return `Invalid path (empty/./.. segment): "${path}"`;
    if (!PATH_SEGMENT_RE.test(segment)) {
      return `Invalid path segment "${segment}" in "${path}" (allowed letters, digits, . _ -)`;
    }
  }
  return null;
}

/**
 * Normalize raw entries into a publish-ready file list, applying the same
 * limits the server enforces so problems surface before submitting.
 */
export function filesToSkillBundle(entries: RawEntry[]): BundleResult {
  const usable = entries.filter((e) => !isJunk(e.path));
  if (usable.length === 0) return { ok: false, error: 'No files found — drop a .zip, a SKILL.md, or a skill folder.' };

  const root = stripCommonRoot(usable.map((e) => e.path));
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  let sizeBytes = 0;

  for (const entry of usable) {
    const path = (root ? entry.path.slice(root.length) : entry.path).replace(/^\/+/, '');
    if (!path) continue;

    const pathError = validatePath(path);
    if (pathError) return { ok: false, error: pathError };
    // Case-insensitive: bundles get written to case-insensitive filesystems on
    // download, where README.md and readme.md collide.
    const lower = path.toLowerCase();
    if (seen.has(lower)) return { ok: false, error: `Duplicate path: "${path}"` };
    seen.add(lower);

    const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
    const isText = TEXT_EXTENSIONS.has(ext);
    files.push(
      isText
        ? { path, content: decodeUtf8(entry.bytes) }
        : { path, content: toBase64(entry.bytes), encoding: 'base64' },
    );
    sizeBytes += entry.bytes.byteLength;
  }

  if (files.length > MAX_FILES) return { ok: false, error: `Too many files (${files.length} > ${MAX_FILES})` };
  if (sizeBytes > MAX_BUNDLE_BYTES) {
    return { ok: false, error: `Bundle too large (${sizeBytes} bytes > ${MAX_BUNDLE_BYTES})` };
  }
  if (!files.some((f) => f.path === 'SKILL.md')) {
    return { ok: false, error: 'Bundle must contain SKILL.md at its root' };
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: true, files, sizeBytes };
}

/**
 * Read the frontmatter fields the dialog previews. Mirrors the server's light
 * reader (skills/bundle.ts) — flat key/value, no YAML dependency. `name` is the
 * skill's identity and is shown read-only; the server rejects a mismatch.
 */
export function readFrontmatter(skillMd: string): { name?: string; description?: string; version?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) return {};
  const out: { name?: string; description?: string; version?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^(name|description|version):\s*(.+)$/.exec(line.trim());
    if (kv) out[kv[1] as 'name' | 'description' | 'version'] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** First `# Heading` of the body — the display name, same derivation as boot-seed. */
export function deriveDisplayName(skillMd: string): string | undefined {
  const body = skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading ? heading[1]!.trim() : undefined;
}
