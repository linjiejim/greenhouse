/**
 * This bundle's own release notes: CHANGELOG.md as it was when the bundle was built
 * (metro.config.js), so a new version brings its notes with it and reads them offline. Parsed on
 * first use only: a launch on a version already seen never reads them.
 */
import changelog from './changelog.generated';
import { parseChangelog, type Release } from './changelog';

let parsed: Release[] | null = null;

export function bundledReleases(): Release[] {
  parsed ??= parseChangelog(changelog);
  return parsed;
}
