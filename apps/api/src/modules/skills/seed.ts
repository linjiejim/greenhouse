/**
 * The official skills: SKILL.md packs under skillhub/<group>/<name>/ that ship with the
 * repository. The API publishes them as team skills when it starts (SKL-10); this file only
 * reads them from disk. A pack's version is its SKILL.md `version`, and CHANGELOG.md has an
 * entry for it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackageFile } from './package.js';

/** The repository's skillhub/ (the image copies the whole repository). */
export const SKILLHUB_DIR = fileURLToPath(new URL('../../../../../skillhub', import.meta.url));

export interface PackRef {
  group: string;
  name: string;
  dir: string;
}

/** Every `<group>/<name>/` with a SKILL.md, by name. */
export function collectPacks(root: string): PackRef[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const found: PackRef[] = [];
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (group.startsWith('.') || !statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      if (!name.startsWith('.') && statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md'))) {
        found.push({ group, name, dir });
      }
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A pack's files, without dotfiles. */
export function readPackFiles(dir: string): PackageFile[] {
  const files: PackageFile[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path: relative(dir, full).split('\\').join('/'), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(dir);
  return files;
}

/** The CHANGELOG.md entry of one version: the text under `## <version>`. */
export function changelogEntry(markdown: string, version: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line.trim()));
  return (
    rest
      .slice(0, end < 0 ? rest.length : end)
      .join('\n')
      .trim() || null
  );
}
