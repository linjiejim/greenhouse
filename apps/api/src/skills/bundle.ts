/**
 * Skill bundle model — validation, canonical form and integrity hash.
 *
 * A skill version's payload is one JSON bundle: the skill's files as
 * `{ path, content, encoding? }` entries (`utf8` default, `base64` for small
 * binary assets), with `SKILL.md` required at the root. This module is the
 * single validation path shared by the HTTP routes and the agent tools —
 * see docs/specs/20260707-skill-center.md.
 */

import { createHash } from 'node:crypto';

export interface SkillFile {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

/** The stored payload shape (one object per version in the skill store). */
export interface SkillBundle {
  format: 1;
  name: string;
  version: string;
  files: SkillFile[];
}

export const MAX_FILES = 64;
export const MAX_BUNDLE_BYTES = 1024 * 1024; // 1 MiB decoded
export const MAX_PATH_LENGTH = 200;

/** kebab-case, ≤ 64 chars, no leading/trailing hyphen — mirrors agent-skill folder names. */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function validateSkillName(name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) {
    return `Invalid skill name "${name}" — use kebab-case ([a-z0-9-], no leading/trailing "-", max 64 chars)`;
  }
  return null;
}

function validatePath(path: string): string | null {
  if (path.length > MAX_PATH_LENGTH) return `Path too long (max ${MAX_PATH_LENGTH}): "${path.slice(0, 50)}…"`;
  if (path.includes('\\')) return `Use "/" as the path separator: "${path}"`;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return `Invalid path (empty/./.. segment): "${path}"`;
    if (!PATH_SEGMENT_RE.test(seg)) return `Invalid path segment "${seg}" in "${path}" (allowed: [A-Za-z0-9._-])`;
  }
  return null;
}

function decodedSize(file: SkillFile): number {
  return file.encoding === 'base64'
    ? Buffer.from(file.content, 'base64').byteLength
    : Buffer.byteLength(file.content, 'utf8');
}

export interface ValidatedBundle {
  /** Files sorted by path with encoding normalized — the canonical order. */
  files: SkillFile[];
  fileCount: number;
  sizeBytes: number;
}

export type BundleValidation = { ok: true; value: ValidatedBundle } | { ok: false; error: string };

const BASE64_RE = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;

/** Validate a publish payload's file list and return its canonical form. */
export function validateBundleFiles(files: SkillFile[]): BundleValidation {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'files must be a non-empty array' };
  if (files.length > MAX_FILES) return { ok: false, error: `Too many files (${files.length} > ${MAX_FILES})` };

  const seen = new Set<string>();
  let sizeBytes = 0;
  for (const file of files) {
    const pathError = validatePath(file.path);
    if (pathError) return { ok: false, error: pathError };
    // Case-insensitive duplicate guard: bundles get written to case-insensitive
    // filesystems (macOS/Windows) on download, where README.md and readme.md collide.
    const lower = file.path.toLowerCase();
    if (seen.has(lower)) return { ok: false, error: `Duplicate path: "${file.path}"` };
    seen.add(lower);

    if (file.encoding && file.encoding !== 'utf8' && file.encoding !== 'base64') {
      return { ok: false, error: `Invalid encoding "${String(file.encoding)}" for "${file.path}" (utf8 | base64)` };
    }
    if (typeof file.content !== 'string') return { ok: false, error: `content must be a string: "${file.path}"` };
    if (file.encoding === 'base64' && !BASE64_RE.test(file.content)) {
      return { ok: false, error: `content is not valid base64: "${file.path}"` };
    }
    sizeBytes += decodedSize(file);
  }
  if (sizeBytes > MAX_BUNDLE_BYTES) {
    return { ok: false, error: `Bundle too large (${sizeBytes} bytes > ${MAX_BUNDLE_BYTES})` };
  }
  if (!files.some((f) => f.path === 'SKILL.md')) {
    return { ok: false, error: 'Bundle must contain SKILL.md at its root' };
  }

  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => ({
      path: f.path,
      content: f.content,
      encoding: f.encoding === 'base64' ? ('base64' as const) : undefined,
    }))
    .map((f) => (f.encoding ? f : { path: f.path, content: f.content }));

  return { ok: true, value: { files: canonical, fileCount: canonical.length, sizeBytes } };
}

/** SHA-256 over the canonical (path-sorted) file list — the version's integrity hash. */
export function bundleContentHash(canonicalFiles: SkillFile[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalFiles)).digest('hex');
}

/** Serialize the stored payload for a version. */
export function buildBundleJson(name: string, version: string, canonicalFiles: SkillFile[]): string {
  const bundle: SkillBundle = { format: 1, name, version, files: canonicalFiles };
  return JSON.stringify(bundle);
}

/** Parse a stored payload; null when it is not a well-formed bundle. */
export function parseBundleJson(json: string): SkillBundle | null {
  try {
    const parsed = JSON.parse(json) as SkillBundle;
    if (parsed?.format !== 1 || typeof parsed.name !== 'string' || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Light frontmatter reader for SKILL.md — extracts `name:` / `description:`
 * from a leading `---` block. No YAML dependency: agent-skill frontmatter is
 * flat key/value, and this is only used for a consistency check + description
 * fallback (never to reject exotic-but-valid YAML).
 */
export function parseSkillMdFrontmatter(skillMd: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
    if (kv[1] === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}
