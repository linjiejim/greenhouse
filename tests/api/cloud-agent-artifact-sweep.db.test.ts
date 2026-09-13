/**
 * Terminal artifact sweep — the control plane's recovery of deliverables the
 * runner never uploaded.
 *
 * The scenarios here are the ones that used to lose files permanently: a run
 * cancelled or reaped before the runner's upload pass, and a file whose mtime
 * looks old because it was moved into place. In both the bytes sit on the host
 * filesystem and the previous implementation never looked at them again.
 */

import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, UserRow, AgentRunRow, AgentWorkspaceRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

import { sweepWorkspaceArtifacts } from '../../apps/api/src/cloud-agent/artifact-sweep.js';
import { loadCloudAgentConfig } from '../../apps/api/src/cloud-agent/config.js';
import { workspaceDirsFor } from '../../apps/api/src/cloud-agent/workspace.js';
import { persistArtifact } from '../../apps/api/src/cloud-agent/artifact-store.js';
import type { CloudAgentConfig } from '../../apps/api/src/cloud-agent/config.js';

let db: DatabaseProvider;
let user: UserRow;
let workspace: AgentWorkspaceRow;
let run: AgentRunRow;
let config: CloudAgentConfig;

async function newRun(): Promise<AgentRunRow> {
  return db.agentRuns.createRun({
    user_id: user.id,
    workspace_id: workspace.id,
    title: 't',
    prompt: 'p',
    model: 'kimi-k3',
  });
}

/** Write a deliverable into the host-side workspace the sandbox mounts. */
async function writeDeliverable(relativePath: string, contents: string): Promise<void> {
  const { workspaceDir } = workspaceDirsFor(config.dataRoot, user.id, workspace.id);
  const absolute = join(workspaceDir, 'artifacts', relativePath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

describe('Cloud Agent terminal artifact sweep', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `cas-${Date.now()}-${Math.random()}@test.local` });
    workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'w' });
    run = await newRun();
    const dataRoot = await mkdtemp(join(tmpdir(), 'cloud-agent-sweep-'));
    config = { ...loadCloudAgentConfig({ CLOUD_AGENT_DATA_ROOT: dataRoot } as NodeJS.ProcessEnv), dataRoot };
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('recovers a deliverable the runner never uploaded (cancel / wall budget path)', async () => {
    await writeDeliverable('报告.md', '# done');

    const result = await sweepWorkspaceArtifacts(db, config, run);

    expect(result.recovered).toBe(1);
    const artifacts = await db.agentRuns.listArtifacts(run.id);
    expect(artifacts.map((a) => a.path)).toEqual(['报告.md']);
    expect(artifacts[0]!.size_bytes).toBe(Buffer.byteLength('# done'));
  });

  it('recovers nested paths and reports each recovered file to the caller', async () => {
    await writeDeliverable('data/rows.csv', 'a,b\n1,2\n');
    await writeDeliverable('summary.txt', 'ok');

    const seen: string[] = [];
    const result = await sweepWorkspaceArtifacts(db, config, run, (path) => seen.push(path));

    expect(result.recovered).toBe(2);
    expect(seen.sort()).toEqual(['data/rows.csv', 'summary.txt']);
  });

  it('does not re-attach bytes already delivered by an earlier run in the same workspace', async () => {
    // Run 1 delivered this file normally; the workspace is shared, so it is
    // still sitting in artifacts/ when run 2 ends.
    await persistArtifact(db, {
      runId: run.id,
      path: 'report.md',
      buffer: Buffer.from('# done'),
      contentType: 'text/markdown',
    });
    await writeDeliverable('report.md', '# done');

    const second = await newRun();
    const result = await sweepWorkspaceArtifacts(db, config, second);

    expect(result.recovered).toBe(0);
    expect(await db.agentRuns.listArtifacts(second.id)).toEqual([]);
  });

  it('recovers a same-path file whose CONTENT changed since the last delivery', async () => {
    await persistArtifact(db, {
      runId: run.id,
      path: 'report.md',
      buffer: Buffer.from('# v1'),
      contentType: 'text/markdown',
    });
    await writeDeliverable('report.md', '# v2');

    const second = await newRun();
    const result = await sweepWorkspaceArtifacts(db, config, second);

    expect(result.recovered).toBe(1);
    expect((await db.agentRuns.listArtifacts(second.id))[0]!.size_bytes).toBe(Buffer.byteLength('# v2'));
  });

  it('is idempotent — a second sweep of the same run adds nothing', async () => {
    await writeDeliverable('report.md', '# done');

    await sweepWorkspaceArtifacts(db, config, run);
    const again = await sweepWorkspaceArtifacts(db, config, run);

    expect(again.recovered).toBe(0);
    expect(await db.agentRuns.listArtifacts(run.id)).toHaveLength(1);
  });

  it('stops at the per-run ceiling and says so instead of silently truncating', async () => {
    for (let i = 0; i < 52; i++) await writeDeliverable(`file-${String(i).padStart(2, '0')}.txt`, `body-${i}`);

    const result = await sweepWorkspaceArtifacts(db, config, run);

    expect(result.recovered).toBe(50);
    expect(result.skipped.some((s) => s.reason.includes('at most 50 artifacts'))).toBe(true);
  });

  it('reports a deliverable it must decline (malformed path) instead of silently dropping it', async () => {
    // A 130-char segment is over sanitizeFileSegment's 120 limit, so the sweep
    // cannot deliver it — the decline must be visible, not a silent continue.
    await writeDeliverable(`${'x'.repeat(130)}.txt`, 'junk');

    const result = await sweepWorkspaceArtifacts(db, config, run);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('malformed path');
  });

  it('surfaces the scan cap as a skip instead of silently truncating the walk', async () => {
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => writeDeliverable(`f-${String(i).padStart(3, '0')}.txt`, String(i))),
    );

    const result = await sweepWorkspaceArtifacts(db, config, run);

    expect(result.recovered).toBe(50);
    expect(result.skipped.some((s) => s.reason.includes('scan capped at 500 files'))).toBe(true);
  });

  it('returns empty without throwing when the workspace directory does not exist', async () => {
    expect(await sweepWorkspaceArtifacts(db, config, run)).toEqual({ recovered: 0, skipped: [] });
  });

  it('never follows an artifact file symlink into the host namespace', async () => {
    const hostDir = await mkdtemp(join(tmpdir(), 'cloud-agent-host-sentinel-'));
    const sentinel = join(hostDir, 'secret.txt');
    await writeFile(sentinel, 'HOST SECRET', 'utf8');
    const { workspaceDir } = workspaceDirsFor(config.dataRoot, user.id, workspace.id);
    const root = join(workspaceDir, 'artifacts');
    await mkdir(root, { recursive: true });
    await symlink(sentinel, join(root, 'report.txt'));

    const result = await sweepWorkspaceArtifacts(db, config, run);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toContainEqual({ path: 'report.txt', reason: 'symbolic links are not allowed' });
    expect(await db.agentRuns.listArtifacts(run.id)).toEqual([]);
  });

  it('never follows a symlink used as the artifacts root', async () => {
    const hostDir = await mkdtemp(join(tmpdir(), 'cloud-agent-host-root-'));
    await writeFile(join(hostDir, 'secret.txt'), 'HOST ROOT SECRET', 'utf8');
    const { workspaceDir } = workspaceDirsFor(config.dataRoot, user.id, workspace.id);
    await mkdir(workspaceDir, { recursive: true });
    await symlink(hostDir, join(workspaceDir, 'artifacts'));

    const result = await sweepWorkspaceArtifacts(db, config, run);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toContainEqual({
      path: 'artifacts/',
      reason: 'symbolic links and non-directory artifact roots are not allowed',
    });
    expect(await db.agentRuns.listArtifacts(run.id)).toEqual([]);
  });

  it('skips an archived workspace (its local dir has already been reclaimed)', async () => {
    await writeDeliverable('report.md', '# done');
    await db.agentRuns.updateWorkspace(workspace.id, { status: 'archived' });

    const result = await sweepWorkspaceArtifacts(db, config, run);

    expect(result.recovered).toBe(0);
  });
});
