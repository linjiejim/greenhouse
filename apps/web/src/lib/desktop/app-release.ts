/**
 * The shell (full app) release index, served next to the updater feed:
 *
 *   <api origin>/updates/desktop/stable/app/downloads.json
 *
 * Written by scripts/desktop/merge-app-release.mjs on every shell release; read by
 * the web settings download card and the shell-update fallback link. Parsed
 * defensively — the file legitimately does not exist until the first shell
 * release is published (and never exists against a local dev API).
 */

import { parseSemver } from '@greenhouse/utils/semver';
import { getApiBaseUrl } from '../api-base';

export interface AppDownloadPlatform {
  /** Human platform name, e.g. "macOS (Apple Silicon)" / "Windows (x64)". */
  label: string;
  /** Absolute URL of the installer (`.dmg` / `-setup.exe`). */
  url: string;
  sizeBytes: number;
}

export interface AppDownloads {
  version: string;
  nativeApiVersion: string;
  releasedAt: string;
  platforms: Record<string, AppDownloadPlatform>;
}

export function appDownloadsUrl(): string {
  return `${getApiBaseUrl()}/updates/desktop/stable/app/downloads.json`;
}

export async function fetchAppDownloads(): Promise<AppDownloads | null> {
  try {
    const response = await fetch(appDownloadsUrl(), { cache: 'no-store' });
    if (!response.ok) return null;
    return parseAppDownloads(await response.json());
  } catch {
    return null;
  }
}

export function parseAppDownloads(value: unknown): AppDownloads | null {
  if (!value || typeof value !== 'object') return null;
  const doc = value as Partial<AppDownloads> & { schemaVersion?: unknown };
  if (doc.schemaVersion !== 1) return null;
  if (typeof doc.version !== 'string' || typeof doc.nativeApiVersion !== 'string') return null;
  if (typeof doc.releasedAt !== 'string' || !doc.platforms || typeof doc.platforms !== 'object') return null;

  const platforms: Record<string, AppDownloadPlatform> = {};
  for (const [key, entry] of Object.entries(doc.platforms)) {
    if (!entry || typeof entry !== 'object') return null;
    const platform = entry as Partial<AppDownloadPlatform>;
    if (
      typeof platform.label !== 'string' ||
      typeof platform.url !== 'string' ||
      !platform.url.startsWith('https://') ||
      typeof platform.sizeBytes !== 'number' ||
      platform.sizeBytes <= 0
    ) {
      return null;
    }
    platforms[key] = { label: platform.label, url: platform.url, sizeBytes: platform.sizeBytes };
  }
  if (Object.keys(platforms).length === 0) return null;

  return {
    version: doc.version,
    nativeApiVersion: doc.nativeApiVersion,
    releasedAt: doc.releasedAt,
    platforms,
  };
}

/**
 * `platforms` key for a running shell, e.g. `darwin-aarch64`.
 *
 * The index uses the updater's platform naming; `DesktopInfo.platform` carries
 * Rust's, where macOS is `macos`.
 */
export function platformKey(info: { platform: string; arch: string }): string {
  return `${info.platform === 'macos' ? 'darwin' : info.platform}-${info.arch}`;
}

/** The installer published for a running shell, or null if this platform has none. */
export function installerFor(
  downloads: AppDownloads,
  info: { platform: string; arch: string },
): AppDownloadPlatform | null {
  return downloads.platforms[platformKey(info)] ?? null;
}

/**
 * Is the published release newer than the installed shell?
 *
 * An unreadable version on either side is never an upgrade: offering a download
 * that turns out to be the same build is worse than staying quiet.
 */
export function isNewerRelease(published: string, installed: string): boolean {
  const next = parseSemver(published);
  const current = parseSemver(installed);
  if (!next || !current) return false;
  if (next.major !== current.major) return next.major > current.major;
  if (next.minor !== current.minor) return next.minor > current.minor;
  return next.patch > current.patch;
}
