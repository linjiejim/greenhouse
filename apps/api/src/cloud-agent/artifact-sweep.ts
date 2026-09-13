/**
 * Terminal artifact sweep — the control plane's own look at `artifacts/`.
 *
 * The runner only uploads on its own clean exit, which is exactly the path
 * that does NOT happen when a run is cancelled, blows its wall budget, exceeds
 * its workspace quota, loses its container, or crashes. In all of those the
 * deliverables are sitting right there on the host filesystem and the user
 * gets told the run failed with nothing attached — and because the workspace
 * is persistent and the runner's freshness heuristic is mtime-based, the next
 * run skips those same files as "old". They became permanently unreachable.
 *
 * So the api scans the directory itself at terminal state. It runs on EVERY
 * terminal path, successful ones included, as a backstop for the runner's own
 * skips (the ceiling, a preserved timestamp, an unreadable subdirectory).
 *
 * "New" is decided by content, not time: any (path, sha256) never delivered by
 * any run in this workspace. That is what makes it safe to re-scan a shared
 * directory on every run without re-attaching last week's report.
 */

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { AgentRunRow, DatabaseProvider } from '@greenhouse/db';

import type { SandboxRunnerConfig } from './config.js';
import { workspaceDirsFor } from './workspace.js';
import {
  MAX_ARTIFACTS_PER_RUN,
  MAX_ARTIFACT_BYTES,
  persistArtifact,
  sanitizeArtifactPath,
  sha256Of,
} from './artifact-store.js';

/** Depth guard mirroring the upload route's 8-segment path limit. */
const MAX_DEPTH = 8;
/** Cap on files inspected per sweep, so a workspace full of junk can't stall settle(). */
const MAX_SCANNED_FILES = 500;

export interface SweepResult {
  recovered: number;
  skipped: Array<{ path: string; reason: string }>;
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

function guessContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream';
}

/** Enumerate regular files under `root`, tolerating per-directory failures. */
async function listFiles(root: string, skipped: SweepResult['skipped']): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_SCANNED_FILES) return;
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        skipped.push({
          path: relative(root, dir) || 'artifacts/',
          reason: 'symbolic links and non-directory artifact roots are not allowed',
        });
        return;
      }
    } catch {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — the rest of the scan still counts
    }
    for (const entry of entries) {
      if (found.length >= MAX_SCANNED_FILES) return;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        found.push(absolute);
      } else if (entry.isSymbolicLink()) {
        // The API runs in the host namespace (often as root). Following a
        // sandbox-created link here would turn it into a confused deputy that
        // uploads arbitrary host files. Links are never deliverables.
        skipped.push({ path: relative(root, absolute), reason: 'symbolic links are not allowed' });
      }
    }
  };
  await visit(root, 1);
  return found;
}

/**
 * Recover deliverables the runner never managed to upload.
 *
 * Never throws: this is called from the terminal settle path, where a failure
 * to attach a bonus file must not stop the run from being finalized.
 */
export async function sweepWorkspaceArtifacts(
  db: DatabaseProvider,
  config: SandboxRunnerConfig,
  run: AgentRunRow,
  emit?: (path: string, sizeBytes: number) => void,
): Promise<SweepResult> {
  const result: SweepResult = { recovered: 0, skipped: [] };
  try {
    const workspace = await db.agentRuns.getWorkspaceById(run.workspace_id);
    // An archived workspace's local dir is already reclaimed (the tarball on
    // object storage is the copy of record), so there is nothing to scan.
    if (!workspace || workspace.status !== 'active') return result;

    const { workspaceDir } = workspaceDirsFor(config.dataRoot, run.user_id, run.workspace_id);
    const root = join(workspaceDir, 'artifacts');
    const files = await listFiles(root, result.skipped);
    if (files.length === 0) return result;
    // A capped walk that reports only what it saw would read as "covered
    // everything" — the cap itself must be one of the skips.
    if (files.length >= MAX_SCANNED_FILES) {
      result.skipped.push({
        path: 'artifacts/',
        reason: `scan capped at ${MAX_SCANNED_FILES} files; later files were not examined`,
      });
    }

    const delivered = new Set(
      (await db.agentRuns.listArtifactDigestsForWorkspace(run.workspace_id)).map((d) => `${d.path}\0${d.sha256}`),
    );

    for (const absolute of files) {
      const path = sanitizeArtifactPath(relative(root, absolute));
      if (!path) {
        result.skipped.push({ path: relative(root, absolute), reason: 'malformed path' });
        continue;
      }
      try {
        // O_NOFOLLOW binds validation and reading to the same regular-file
        // handle. A separate stat/readFile pair leaves a swap-to-symlink race.
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        let buffer: Buffer;
        try {
          const info = await handle.stat();
          if (!info.isFile()) {
            result.skipped.push({ path, reason: 'not a regular file' });
            continue;
          }
          if (info.size > MAX_ARTIFACT_BYTES) {
            result.skipped.push({ path, reason: 'exceeds size limit' });
            continue;
          }
          buffer = await handle.readFile();
          if (buffer.length > MAX_ARTIFACT_BYTES) {
            result.skipped.push({ path, reason: 'exceeds size limit' });
            continue;
          }
        } finally {
          await handle.close();
        }
        if (delivered.has(`${path}\0${sha256Of(buffer)}`)) continue;

        const stored = await persistArtifact(db, {
          runId: run.id,
          path,
          buffer,
          contentType: guessContentType(path),
        });
        if (!stored.ok) {
          // `conflict` means this exact path already came from this run with
          // different bytes — the agent rewrote it after the upload. The
          // uploaded version is the one it reported, so keep it.
          if (stored.code !== 'conflict') result.skipped.push({ path, reason: stored.message });
          if (stored.code === 'limit_reached') break;
          continue;
        }
        if (!stored.idempotent) {
          result.recovered += 1;
          emit?.(path, buffer.length);
        }
      } catch (err) {
        result.skipped.push({ path, reason: toErrorMessage(err) });
      }
    }

    if (result.recovered > 0 || result.skipped.length > 0) {
      logger.info('[cloud-agent] terminal artifact sweep', {
        runId: run.id,
        recovered: result.recovered,
        skipped: result.skipped.length,
        limit: MAX_ARTIFACTS_PER_RUN,
      });
    }
  } catch (err) {
    logger.error('[cloud-agent] artifact sweep failed', { runId: run.id, err: toErrorMessage(err) });
  }
  return result;
}
