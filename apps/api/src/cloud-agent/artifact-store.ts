/**
 * Artifact persistence — the one place bytes become an `agent_artifacts` row.
 *
 * Two callers, deliberately sharing this rather than each doing their own
 * upload + insert: the runner's internal upload route, and the terminal sweep
 * that re-scans the host workspace after a run ends (artifact-sweep.ts). The
 * sweep exists precisely because the runner cannot be trusted to have run at
 * all — cancel, wall budget and container loss all kill it mid-flight — so the
 * two paths must agree byte-for-byte on limits, path hygiene, storage keys and
 * idempotency, or "recovered" files would land under different rules than
 * uploaded ones.
 */

import { createHash } from 'node:crypto';
import type { AgentArtifactRow, DatabaseProvider } from '@greenhouse/db';

import { putObjectAtKey } from '../storage/uploads.js';
import { sanitizeFileSegment } from '../storage/filename.js';

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_RUN = 50;

/**
 * Normalize a relative deliverable path; null when it's unacceptable.
 *
 * Segments are normalized rather than rejected — an ASCII-only rule used to
 * 400 every CJK-named artifact, so the agent wrote the file, truthfully
 * reported success, and the user simply had no card (2026-07-31).
 */
export function sanitizeArtifactPath(raw: string): string | null {
  const segments = raw.split(/[/\\]/).filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 8) return null;
  const safe: string[] = [];
  for (const segment of segments) {
    const clean = sanitizeFileSegment(segment);
    if (!clean) return null;
    safe.push(clean);
  }
  return safe.join('/');
}

export function artifactStorageKey(runId: string, path: string): string {
  return `cloud-agent/${runId}/${path}`;
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export type PersistArtifactResult =
  | { ok: true; artifact: AgentArtifactRow; idempotent: boolean }
  | { ok: false; code: 'limit_reached' | 'too_large' | 'conflict'; message: string };

export interface PersistArtifactInput {
  runId: string;
  /** Already sanitized (callers own the 400 for a malformed path). */
  path: string;
  buffer: Buffer;
  contentType: string;
}

/**
 * Store one deliverable under a run, idempotently.
 *
 * Same (path, bytes) → the existing row is acknowledged: a runner retry after
 * a lost response must not turn a successful delivery into `artifact.failed`.
 * Same path, different bytes → conflict, because silently overwriting would
 * make the delivered file depend on request ordering.
 */
export async function persistArtifact(
  db: DatabaseProvider,
  input: PersistArtifactInput,
): Promise<PersistArtifactResult> {
  if (input.buffer.length > MAX_ARTIFACT_BYTES) {
    return { ok: false, code: 'too_large', message: `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes` };
  }
  const existing = await db.agentRuns.listArtifacts(input.runId);
  const sha256 = sha256Of(input.buffer);
  const prior = existing.find((artifact) => artifact.path === input.path);
  if (prior) {
    if (prior.size_bytes === input.buffer.length && prior.sha256 === sha256) {
      return { ok: true, artifact: prior, idempotent: true };
    }
    return { ok: false, code: 'conflict', message: `artifact already uploaded with different content: ${input.path}` };
  }
  if (existing.length >= MAX_ARTIFACTS_PER_RUN) {
    return { ok: false, code: 'limit_reached', message: `at most ${MAX_ARTIFACTS_PER_RUN} artifacts per run` };
  }

  const storageKey = artifactStorageKey(input.runId, input.path);
  await putObjectAtKey(storageKey, input.buffer, input.contentType);
  const artifact = await db.agentRuns.createArtifact({
    run_id: input.runId,
    path: input.path,
    size_bytes: input.buffer.length,
    content_type: input.contentType,
    sha256,
    storage_key: storageKey,
  });
  return { ok: true, artifact, idempotent: false };
}
