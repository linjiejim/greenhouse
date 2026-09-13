/** Persistent Cloud Agent workspace accounting, archive and restore. */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdtemp, lstat, open, readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AgentWorkspaceRow, DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { nowIso } from '@greenhouse/utils/date';

import type { SandboxRunnerConfig } from './config.js';
import { workspaceDirsFor } from './workspace.js';
import { getObjectAtKey, putObjectAtKey } from '../storage/uploads.js';

const execFileAsync = promisify(execFile);
const MAX_JOURNAL_BYTES = 25 * 1024 * 1024;
const MAX_MEASUREMENT_ENTRIES = 25_000;
const MAX_MEASUREMENT_MS = 2_000;

export class WorkspaceMeasurementLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMeasurementLimitError';
  }
}

function workspaceHome(config: SandboxRunnerConfig, workspace: Pick<AgentWorkspaceRow, 'id' | 'user_id'>): string {
  return dirname(workspaceDirsFor(config.dataRoot, workspace.user_id, workspace.id).workspaceDir);
}

interface MeasurementState {
  entries: number;
  maxEntries: number;
  maxMs: number;
  deadlineAt: number;
}

function assertMeasurementBudget(state: MeasurementState): void {
  state.entries += 1;
  if (state.entries > state.maxEntries) {
    throw new WorkspaceMeasurementLimitError(`workspace contains more than ${state.maxEntries} measurable entries`);
  }
  if (Date.now() > state.deadlineAt) {
    throw new WorkspaceMeasurementLimitError(`workspace measurement exceeded ${state.maxMs} ms`);
  }
}

function assertMeasurementDeadline(state: MeasurementState): void {
  if (Date.now() > state.deadlineAt) {
    throw new WorkspaceMeasurementLimitError(`workspace measurement exceeded ${state.maxMs} ms`);
  }
}

async function measurePath(path: string, state: MeasurementState): Promise<number> {
  assertMeasurementBudget(state);
  let stat;
  try {
    stat = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let bytes = 0;
  const entries = await readdir(path);
  assertMeasurementDeadline(state);
  for (const entry of entries) bytes += await measurePath(join(path, entry), state);
  return bytes;
}

export async function measureWorkspaceBytes(
  config: SandboxRunnerConfig,
  workspace: Pick<AgentWorkspaceRow, 'id' | 'user_id'>,
  options: { maxEntries?: number; maxMs?: number } = {},
): Promise<number> {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? MAX_MEASUREMENT_ENTRIES));
  const maxMs = Math.max(1, Math.floor(options.maxMs ?? MAX_MEASUREMENT_MS));
  return measurePath(workspaceHome(config, workspace), {
    entries: 0,
    maxEntries,
    maxMs,
    deadlineAt: Date.now() + maxMs,
  });
}

function archiveKey(workspace: Pick<AgentWorkspaceRow, 'id' | 'user_id'>): string {
  return `cloud-agent/workspace-archives/${workspace.user_id}/ws-${workspace.id}.tar.gz`;
}

/** Upload first; only a durable object permits the local directory to be removed. */
export async function archiveWorkspace(
  db: DatabaseProvider,
  config: SandboxRunnerConfig,
  workspace: AgentWorkspaceRow,
): Promise<void> {
  const home = workspaceHome(config, workspace);
  const parent = dirname(home);
  await mkdir(parent, { recursive: true });
  await mkdir(home, { recursive: true });
  const temp = await mkdtemp(join(parent, `.archive-ws-${workspace.id}-`));
  const tarPath = join(temp, 'workspace.tar.gz');
  try {
    await execFileAsync('tar', ['-czf', tarPath, '-C', home, '.']);
    const archive = await readFile(tarPath);
    const key = archiveKey(workspace);
    await putObjectAtKey(key, archive, 'application/gzip');
    await db.agentRuns.updateWorkspace(workspace.id, {
      status: 'archived',
      cos_archive_key: key,
      disk_bytes: archive.length,
    });
    await rm(home, { recursive: true, force: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function assertSafeArchiveListing(stdout: string): void {
  for (const raw of stdout.split('\n')) {
    const entry = raw.replace(/^\.\//, '');
    if (!entry) continue;
    if (entry.startsWith('/') || entry.split('/').some((segment) => segment === '..')) {
      throw new Error(`Workspace archive contains an unsafe path: ${raw}`);
    }
  }
}

export async function restoreWorkspaceIfArchived(
  db: DatabaseProvider,
  config: SandboxRunnerConfig,
  workspace: AgentWorkspaceRow,
): Promise<AgentWorkspaceRow> {
  if (workspace.status !== 'archived') return workspace;
  if (!workspace.cos_archive_key) throw new Error('Archived workspace has no object-storage key');
  const stored = await getObjectAtKey(workspace.cos_archive_key);
  if (!stored) throw new Error('Archived workspace content is missing from storage');

  const home = workspaceHome(config, workspace);
  const parent = dirname(home);
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, `.restore-ws-${workspace.id}-`));
  const tarPath = join(temp, 'workspace.tar.gz');
  const extracted = join(temp, 'content');
  try {
    await writeFile(tarPath, stored.buffer);
    const { stdout } = await execFileAsync('tar', ['-tzf', tarPath]);
    assertSafeArchiveListing(stdout);
    await mkdir(extracted, { recursive: true });
    await execFileAsync('tar', ['-xzf', tarPath, '--no-same-owner', '-C', extracted]);
    await rm(home, { recursive: true, force: true });
    await rename(extracted, home);
    const diskBytes = await measurePath(home, {
      entries: 0,
      maxEntries: MAX_MEASUREMENT_ENTRIES,
      maxMs: MAX_MEASUREMENT_MS,
      deadlineAt: Date.now() + MAX_MEASUREMENT_MS,
    });
    return (
      (await db.agentRuns.updateWorkspace(workspace.id, {
        status: 'active',
        cos_archive_key: null,
        disk_bytes: diskBytes,
        last_used_at: nowIso(),
      })) ?? workspace
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function archiveStaleWorkspaces(db: DatabaseProvider, config: SandboxRunnerConfig): Promise<number> {
  const cutoff = new Date(Date.now() - config.archiveAfterDays * 86_400_000).toISOString();
  const candidates = await db.agentRuns.listArchivableWorkspaces(cutoff, 20);
  let archived = 0;
  for (const workspace of candidates) {
    try {
      await archiveWorkspace(db, config, workspace);
      archived += 1;
    } catch (err) {
      logger.error('[cloud-agent] workspace archive failed', { workspaceId: workspace.id, err: String(err) });
    }
  }
  return archived;
}

export async function archiveRunJournal(
  db: DatabaseProvider,
  config: SandboxRunnerConfig,
  run: { id: string; user_id: string; workspace_id: number },
): Promise<string | null> {
  const journalPath = join(
    workspaceDirsFor(config.dataRoot, run.user_id, run.workspace_id).sessionDir,
    'journal.jsonl',
  );
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NOFOLLOW binds the read to a regular file at open time. A preceding
    // lstat alone would leave a swap-to-symlink race for the sandbox owner.
    handle = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Cloud Agent journal is not a regular file');
    const length = Math.min(stat.size, MAX_JOURNAL_BYTES);
    buffer = Buffer.alloc(length);
    const offset = Math.max(0, stat.size - length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const key = `cloud-agent/journals/${run.user_id}/${run.id}.jsonl`;
  await putObjectAtKey(key, buffer, 'application/x-ndjson');
  await db.agentRuns.updateRun(run.id, { journal_storage_key: key });
  return key;
}
