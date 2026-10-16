/**
 * SKILL.md packages. An upload is a ZIP with SKILL.md at its root (or inside one top folder),
 * read within limits: at most 100 files and 10 MB unpacked, sizes checked from the ZIP's
 * directory before anything is inflated, and every path relative and plain. SKILL.md's
 * frontmatter gives the name, the description, an optional version and the requirements.
 *
 * What is stored is a canonical ZIP: `<name>/<path>`, sorted, with fixed times, so the same files
 * always make the same package. Its hash is over the files themselves, never the ZIP's bytes.
 */

import { createHash } from 'node:crypto';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { parse as parseYaml } from 'yaml';
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_DISPLAY_NAME_MAX,
  SKILL_NAME_PATTERN,
  SKILL_TAGS_MAX,
  skillRequirementsSchema,
  skillVersionNumberSchema,
  type SkillRequirements,
} from '@greenhouse/contract';

export const PACKAGE_LIMITS = {
  /** The uploaded ZIP. */
  zipBytes: 10 * 1024 * 1024,
  files: 100,
  /** Everything unpacked. */
  totalBytes: 10 * 1024 * 1024,
  /** SKILL.md enters the turn that runs it, so it stays a readable size. */
  skillMdChars: 30_000,
  pathChars: 200,
} as const;

/** Something about the package the member can fix; the message says what. */
export class PackageError extends Error {}

export interface PackageFile {
  path: string;
  bytes: Uint8Array;
}

export interface SkillPackage {
  name: string;
  description: string;
  /** The first `# ` heading of SKILL.md, else the name. */
  displayName: string;
  /** SKILL.md's `version`, when it has one. */
  version: string | null;
  tags: string[];
  requirements: SkillRequirements;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** Sorted by path, SKILL.md included. */
  files: PackageFile[];
  sizeBytes: number;
  sha256: string;
}

const SKILL_MD = 'SKILL.md';
/** What archivers add on their own; skipped, never stored. */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const isJunk = (path: string) =>
  path.startsWith('__MACOSX/') || path.includes('/__MACOSX/') || JUNK_NAMES.has(path.split('/').pop() ?? '');

/** A fixed time for every entry: the same files give the same ZIP. */
const ZIP_TIME = new Date('2026-01-01T00:00:00Z');

const byPath = (a: PackageFile, b: PackageFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * A path inside a package: relative, separated by `/`, without empty, `.` or `..` parts, control
 * characters or anything a file system treats specially.
 */
export function checkPath(path: string): string {
  const shown = JSON.stringify(path.length > 80 ? `${path.slice(0, 80)}…` : path);
  if (path.length > PACKAGE_LIMITS.pathChars) throw new PackageError(`The path ${shown} is too long.`);
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new PackageError(`The path ${shown} has control characters.`);
  if (path.includes('\\')) throw new PackageError(`The path ${shown} uses \\; use / between folders.`);
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new PackageError(`The path ${shown} is absolute.`);
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..') {
      throw new PackageError(`The path ${shown} has an empty, "." or ".." part.`);
    }
    if (/[:*?"<>|]/.test(part) || part !== part.trim()) {
      throw new PackageError(`The path ${shown} has a name files cannot have.`);
    }
  }
  return path;
}

/** The text of a file, or null when it is not UTF-8 text. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** SKILL.md's leading `---` block, parsed, and the text after it. */
export function parseFrontmatter(markdown: string): { data: Record<string, unknown>; body: string } {
  const text = markdown.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new PackageError('SKILL.md must start with a frontmatter block (--- name, description ---).');
  let data: unknown;
  try {
    data = parseYaml(match[1]!, { maxAliasCount: 0, prettyErrors: false });
  } catch (error) {
    throw new PackageError(
      `SKILL.md's frontmatter is not valid YAML: ${String((error as Error).message).slice(0, 200)}`,
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PackageError("SKILL.md's frontmatter must be a list of keys (name, description …).");
  }
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length).replace(/^\s*\n/, '') };
}

const firstHeading = (body: string) => /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();

/** What SKILL.md says about the skill. */
function describe(skillMd: string) {
  const { data, body } = parseFrontmatter(skillMd);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new PackageError(
      name
        ? `The name "${name.slice(0, 80)}" in SKILL.md is not valid: use lower-case letters, digits and hyphens.`
        : 'SKILL.md needs a name in its frontmatter.',
    );
  }
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) throw new PackageError('SKILL.md needs a description in its frontmatter.');
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new PackageError(`The description in SKILL.md is longer than ${SKILL_DESCRIPTION_MAX} characters.`);
  }
  let version: string | null = null;
  if (data.version !== undefined && data.version !== null) {
    const parsed = skillVersionNumberSchema.safeParse(typeof data.version === 'string' ? data.version.trim() : '');
    if (!parsed.success) throw new PackageError('The version in SKILL.md must look like 1.2.0 (in quotes if needed).');
    version = parsed.data;
  }
  const requirements = skillRequirementsSchema.safeParse(data.requirements ?? {});
  if (!requirements.success) {
    throw new PackageError(
      'requirements in SKILL.md can only say `computer: true` and list `connectors:` by their slugs.',
    );
  }
  const tags = Array.isArray(data.tags)
    ? data.tags
        .filter((tag): tag is string => typeof tag === 'string' && !!tag.trim())
        .map((tag) => tag.trim().slice(0, 30))
        .slice(0, SKILL_TAGS_MAX)
    : [];
  return {
    name,
    description,
    displayName: (firstHeading(body) ?? name).slice(0, SKILL_DISPLAY_NAME_MAX),
    version,
    tags,
    requirements: requirements.data,
    body: body.trim(),
  };
}

/** Checks a set of files as a package and reads its SKILL.md. Used for uploads and for skillhub/. */
export function readPackage(input: readonly PackageFile[]): SkillPackage {
  if (!input.length) throw new PackageError('The package is empty.');
  if (input.length > PACKAGE_LIMITS.files) {
    throw new PackageError(`A package can have up to ${PACKAGE_LIMITS.files} files.`);
  }
  const seen = new Set<string>();
  let sizeBytes = 0;
  for (const file of input) {
    checkPath(file.path);
    // Case-insensitive: README.md and readme.md would be one file on macOS and Windows.
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new PackageError(`"${file.path}" is in the package twice.`);
    seen.add(key);
    sizeBytes += file.bytes.byteLength;
  }
  if (sizeBytes > PACKAGE_LIMITS.totalBytes) throw new PackageError('The package is larger than 10 MB unpacked.');
  const skillFile = input.find((file) => file.path === SKILL_MD);
  if (!skillFile) throw new PackageError('The package needs a SKILL.md at its top.');
  const skillMd = textOf(skillFile.bytes);
  if (skillMd === null) throw new PackageError('SKILL.md must be UTF-8 text.');
  if (skillMd.length > PACKAGE_LIMITS.skillMdChars) {
    throw new PackageError(`SKILL.md can be up to ${PACKAGE_LIMITS.skillMdChars} characters.`);
  }
  const files = [...input].sort(byPath);
  return { ...describe(skillMd), files, sizeBytes, sha256: contentHash(files) };
}

/**
 * Reads an uploaded ZIP. Sizes and the file count are checked from its directory before
 * anything is inflated, and an entry never inflates past the size the directory gave it.
 */
export function readPackageZip(zip: Uint8Array): SkillPackage {
  if (zip.byteLength > PACKAGE_LIMITS.zipBytes) throw new PackageError('The ZIP is larger than 10 MB.');
  let count = 0;
  let declared = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter(entry) {
        if (entry.name.endsWith('/') || isJunk(entry.name)) return false;
        count += 1;
        if (count > PACKAGE_LIMITS.files) {
          throw new PackageError(`A package can have up to ${PACKAGE_LIMITS.files} files.`);
        }
        if (entry.compression !== 0 && entry.compression !== 8) {
          throw new PackageError(`"${entry.name.slice(0, 80)}" is compressed in a way this cannot read.`);
        }
        declared += entry.originalSize;
        if (declared > PACKAGE_LIMITS.totalBytes) throw new PackageError('The package is larger than 10 MB unpacked.');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError('This is not a ZIP file that can be read.');
  }
  const files = Object.entries(entries).map(([path, bytes]) => ({ path: checkPath(path), bytes }));
  // A ZIP of the skill's folder: SKILL.md sits in one top folder, which is dropped.
  if (!files.some((file) => file.path === SKILL_MD)) {
    const top = files[0]?.path.split('/')[0];
    const nested = top !== undefined && files.every((file) => file.path.startsWith(`${top}/`));
    if (nested && files.some((file) => file.path === `${top}/${SKILL_MD}`)) {
      return readPackage(files.map((file) => ({ path: file.path.slice(top.length + 1), bytes: file.bytes })));
    }
  }
  return readPackage(files);
}

/** The canonical ZIP: `<name>/<path>` for every file, in path order, with fixed times. */
export function packageZip(name: string, files: readonly PackageFile[]): Uint8Array {
  const entries: Zippable = {};
  for (const file of [...files].sort(byPath)) entries[`${name}/${file.path}`] = [file.bytes, { mtime: ZIP_TIME }];
  return zipSync(entries, { level: 6, mtime: ZIP_TIME });
}

/** The hash of a package's content: each file's path, size and bytes, in path order. */
export function contentHash(files: readonly PackageFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort(byPath)) {
    hash.update(`${file.path}\n${file.bytes.byteLength}\n`);
    hash.update(file.bytes);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** The ZIP's file name for a download. */
export const packageFilename = (name: string, version: string) => `${name}-${version}.zip`;
