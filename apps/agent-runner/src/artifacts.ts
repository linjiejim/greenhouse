/**
 * Deliverable discovery inside the sandbox — what gets uploaded, and what is
 * reported as skipped.
 *
 * This used to live inline in index.ts with no test seam, and every one of its
 * drop paths was silent: a stale mtime, the 50-file ceiling, one unreadable
 * subdirectory. All three produced a `completed` run with a shorter artifact
 * list than the agent believed it had written, and nothing anywhere said so.
 * So collection is now a pure function over injected fs/clock that returns
 * BOTH what to upload and why anything was left out — the caller turns the
 * latter into `artifact.skipped` timeline rows.
 *
 * It is still best-effort by design: the control plane re-scans the host
 * workspace at terminal state (artifact-sweep.ts) and recovers whatever this
 * pass missed, including runs where the container died before it ever ran.
 */

import { readdirSync, statSync, type Dirent, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentArtifactSkipReason } from '@greenhouse/types/cloud-agent';

export interface ArtifactCandidate {
  /** Absolute path in the container. */
  absolutePath: string;
  /** Path relative to the artifacts root — the key the api stores. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ArtifactSkip {
  path: string;
  reason: AgentArtifactSkipReason;
  detail?: string;
}

export interface CollectArtifactsResult {
  upload: ArtifactCandidate[];
  skipped: ArtifactSkip[];
}

export interface CollectArtifactsOptions {
  root: string;
  /** Files last modified before this are assumed to belong to an earlier run. */
  freshSinceMs: number;
  maxFiles: number;
  maxBytes: number;
  /** Test seams. */
  fs?: {
    readdirSync: (path: string, options: { withFileTypes: true }) => Dirent[];
    statSync: (path: string) => Stats;
  };
}

interface WalkEntry {
  absolutePath: string;
  path: string;
}

/**
 * Enumerate every regular file under `root`.
 *
 * Errors are per-entry, not per-walk: the previous version wrapped the whole
 * recursion in one try/catch and `return []`-ed on any failure, so a single
 * unreadable subdirectory discarded every file already collected and the run
 * reported `artifacts: 0` with no error anywhere.
 */
function walkFiles(root: string, fs: NonNullable<CollectArtifactsOptions['fs']>, skipped: ArtifactSkip[]): WalkEntry[] {
  const found: WalkEntry[] = [];
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: relative(root, dir) || '.', reason: 'walk_error', detail: String(err) });
      return;
    }
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const path = relative(root, absolutePath);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        found.push({ absolutePath, path });
        continue;
      }
      // Never follow links. Besides making deliverables non-portable, a link
      // can point outside artifacts (for example at session credentials).
      // The host-side recovery pass follows the same fail-closed rule.
      if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: 'unreadable', detail: 'symbolic links are not allowed' });
      }
    }
  };
  visit(root);
  return found;
}

/**
 * Decide what this run uploads.
 *
 * Order matters and is the fix for a real drop: the ceiling is applied AFTER
 * the freshness filter, not before. Workspaces are persistent, so by run N the
 * directory holds every earlier run's deliverables; truncating first let stale
 * files consume all 50 slots and pushed this run's actual output out of the
 * list entirely.
 */
export function collectArtifacts(options: CollectArtifactsOptions): CollectArtifactsResult {
  const fs = options.fs ?? { readdirSync: readdirSync as never, statSync: statSync as never };
  const skipped: ArtifactSkip[] = [];
  const files = walkFiles(options.root, fs, skipped);

  const fresh: ArtifactCandidate[] = [];
  for (const file of files) {
    let stat: Stats;
    try {
      stat = fs.statSync(file.absolutePath);
    } catch (err) {
      skipped.push({ path: file.path, reason: 'unreadable', detail: String(err) });
      continue;
    }
    if (stat.mtimeMs < options.freshSinceMs) {
      // Heuristic, and a lossy one: mv/unzip/cp -p all preserve timestamps, so
      // a genuinely new deliverable can look old. Reported instead of dropped,
      // and the control-plane sweep catches it by content hash regardless.
      skipped.push({ path: file.path, reason: 'stale_mtime' });
      continue;
    }
    if (stat.size > options.maxBytes) {
      skipped.push({ path: file.path, reason: 'too_large', detail: `${stat.size} bytes` });
      continue;
    }
    fresh.push({ absolutePath: file.absolutePath, path: file.path, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
  }

  // Newest first so the ceiling, when it bites, keeps this run's latest work;
  // path breaks ties to keep the order (and the tests) deterministic.
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const upload = fresh.slice(0, options.maxFiles);
  for (const overflow of fresh.slice(options.maxFiles)) {
    skipped.push({ path: overflow.path, reason: 'over_limit' });
  }
  return { upload, skipped };
}

const CONTENT_TYPES: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

export function guessContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream';
}
