/**
 * Runtime version info — the single source of truth for "which build is this?".
 *
 * The product version is derived from the git tag at build time, not from any
 * package.json `version` (those are placeholders — see RELEASING.md). CI injects
 * `APP_VERSION` (the tag, e.g. `v0.2.0` or `edge`) and `APP_REVISION` (the commit
 * sha) as build args → env; `/health` echoes them back so a downloader reporting
 * a bug can be matched to the exact code. Both fall back to dev sentinels when
 * unset (local `pnpm dev`, `tsx`, tests).
 */

export function getAppVersion(): string {
  return process.env.APP_VERSION || '0.0.0-dev';
}

export function getAppRevision(): string {
  return process.env.APP_REVISION || 'unknown';
}

export interface VersionInfo {
  version: string;
  revision: string;
}

export function getVersionInfo(): VersionInfo {
  return { version: getAppVersion(), revision: getAppRevision() };
}
