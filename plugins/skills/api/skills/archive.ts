/** Build the user-facing, installable ZIP representation of a Skill bundle. */

import { strToU8, zipSync, type Zippable } from 'fflate';
import type { SkillFile } from './bundle.js';

/**
 * Keep one shared root directory so extracting the archive never sprays files
 * into the current directory. Bundle paths were already validated at publish
 * time; the skill name is the validated kebab-case catalog key.
 */
export function buildSkillArchive(name: string, files: readonly SkillFile[]): Uint8Array {
  const entries: Zippable = {};
  for (const file of files) {
    entries[`${name}/${file.path}`] =
      file.encoding === 'base64' ? new Uint8Array(Buffer.from(file.content, 'base64')) : strToU8(file.content);
  }
  return zipSync(entries, { level: 6 });
}

export function skillArchiveFilename(name: string, version: string): string {
  return `${name}-${version}.zip`;
}
