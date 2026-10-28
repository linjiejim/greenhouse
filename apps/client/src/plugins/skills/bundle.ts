/**
 * Skill upload in the browser, pure (./bundle.test.ts): picked files (a SKILL.md, several files or
 * a whole skill folder) become the `files[]` that `POST /api/skills/publish` takes, with the
 * station's own limits checked first so a member learns a bundle is too big before sending it.
 * These checks are not the boundary: the Skills plugin validates everything again
 * (plugins/skills/api/skills/bundle.ts; src/shared/vendor.parity.test.ts keeps the limits equal).
 * A .zip is not unpacked here (no archive reader in the client): pick the folder instead.
 */

export const MAX_FILES = 64;
export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const MAX_PATH_LENGTH = 200;

/** kebab-case, ≤ 64 chars, no leading/trailing hyphen — mirrors agent-skill folder names. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Extensions stored as utf8 text; everything else is base64 (the plugin's boot seed does the same). */
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
  'py',
  'sh',
]);

export interface BundleFile {
  path: string;
  content: string;
  encoding?: 'base64';
}

/** One picked file: its path inside the pick (a folder pick keeps the folder) and its bytes. */
export interface PickedFile {
  path: string;
  bytes: Uint8Array;
}

export type BundleProblem =
  | { kind: 'empty' }
  | { kind: 'path'; path: string }
  | { kind: 'duplicate'; path: string }
  | { kind: 'too-many'; count: number }
  | { kind: 'too-big'; bytes: number }
  | { kind: 'no-skill-md' }
  | { kind: 'zip' };

export type BundleResult = { ok: true; files: BundleFile[]; bytes: number } | { ok: false; problem: BundleProblem };

/** Operating-system noise that never belongs in a bundle. */
function isJunk(path: string): boolean {
  return path
    .split('/')
    .some(
      (segment) =>
        segment === '__MACOSX' || segment === '.DS_Store' || segment === 'Thumbs.db' || segment.startsWith('._'),
    );
}

function validPath(path: string): boolean {
  if (path.length > MAX_PATH_LENGTH || path.includes('\\')) return false;
  return path.split('/').every((segment) => segment !== '.' && segment !== '..' && PATH_SEGMENT_RE.test(segment));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/** A folder pick names every file `folder/…`: drop that one shared top folder so SKILL.md sits at the root. */
export function commonRoot(paths: readonly string[]): string {
  const first = paths[0]?.split('/');
  if (!first || first.length < 2) return '';
  const root = `${first[0]}/`;
  return paths.every((path) => path.startsWith(root)) ? root : '';
}

export function bundleFromFiles(picked: readonly PickedFile[]): BundleResult {
  if (picked.some((file) => /\.zip$/i.test(file.path))) return { ok: false, problem: { kind: 'zip' } };
  const usable = picked.filter((file) => !isJunk(file.path));
  if (!usable.length) return { ok: false, problem: { kind: 'empty' } };
  const root = commonRoot(usable.map((file) => file.path));
  const seen = new Set<string>();
  const files: BundleFile[] = [];
  let bytes = 0;
  for (const file of usable) {
    const path = file.path.slice(root.length).replace(/^\/+/, '');
    if (!validPath(path)) return { ok: false, problem: { kind: 'path', path } };
    // Case-insensitive: a download onto macOS or Windows would make README.md and readme.md collide.
    const lower = path.toLowerCase();
    if (seen.has(lower)) return { ok: false, problem: { kind: 'duplicate', path } };
    seen.add(lower);
    const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
    files.push(
      TEXT_EXTENSIONS.has(ext)
        ? { path, content: new TextDecoder('utf-8').decode(file.bytes) }
        : { path, content: toBase64(file.bytes), encoding: 'base64' },
    );
    bytes += file.bytes.byteLength;
  }
  if (files.length > MAX_FILES) return { ok: false, problem: { kind: 'too-many', count: files.length } };
  if (bytes > MAX_BUNDLE_BYTES) return { ok: false, problem: { kind: 'too-big', bytes } };
  if (!files.some((file) => file.path === 'SKILL.md')) return { ok: false, problem: { kind: 'no-skill-md' } };
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: true, files, bytes };
}

/** SKILL.md's flat frontmatter (`name`, `description`, `version`); the station rejects a name mismatch. */
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

/** The first `# Heading` after the frontmatter: the display name the station would derive. */
export function headingOf(skillMd: string): string | undefined {
  const body = skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

/** Strict `x.y.z`, as the station requires. */
export const isSemver = (version: string) => /^\d+\.\d+\.\d+$/.test(version);

/** The next patch version of `x.y.z`, else 0.1.0. */
export function nextVersion(latest: string | undefined): string {
  const m = latest ? /^(\d+)\.(\d+)\.(\d+)$/.exec(latest) : null;
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '0.1.0';
}

/** Tags typed as "a, b, c": trimmed, unique, at most 20. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}
