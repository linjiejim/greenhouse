import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The official plugin folders (packages named `@greenhouse/plugin-*`), sorted. Tests that pin the
 * official schema use this instead of every folder under plugins/, which a private overlay extends.
 */
export function officialPluginIds(root: string): string[] {
  return readdirSync(join(root, 'plugins'))
    .filter((id) => {
      const pkg = join(root, 'plugins', id, 'package.json');
      return existsSync(pkg) && String(JSON.parse(readFileSync(pkg, 'utf8')).name).startsWith('@greenhouse/plugin-');
    })
    .sort();
}
