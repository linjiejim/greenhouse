/**
 * Cloud Agent workspace layout — per-user homes on the host.
 *
 *   <dataRoot>/homes/<userId>/ws-<workspaceId>/workspace  → /workspace  (rw)
 *   <dataRoot>/homes/<userId>/ws-<workspaceId>/session    → /session    (rw)
 *
 * Dirs are keyed by WORKSPACE, not run (integration spec D3): every follow-up
 * run in a mission session mounts the same pair, and the runner's
 * `SessionManager.continueRecent` picks the conversation up with full
 * context. Containers stay fully stateless. Each run's prompt travels as its
 * own file in the session dir (env vars are size-limited and leak into
 * `docker inspect`).
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface RunDirs {
  workspaceDir: string;
  sessionDir: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`${label} contains characters unsafe for a path segment: ${JSON.stringify(value)}`);
  }
}

/**
 * The project-quota boundary is the whole per-user home, not an individual
 * workspace. Keep its path construction beside the workspace layout so the
 * ops attester and the controller cannot drift onto different directories.
 */
export function userHomeFor(dataRoot: string, userId: string): string {
  assertSafeSegment(userId, 'userId');
  return join(dataRoot, 'homes', userId);
}

export function workspaceDirsFor(dataRoot: string, userId: string, workspaceId: number): RunDirs {
  if (!Number.isInteger(workspaceId) || workspaceId < 1) throw new Error(`invalid workspaceId: ${workspaceId}`);
  const home = join(userHomeFor(dataRoot, userId), `ws-${workspaceId}`);
  return {
    workspaceDir: join(home, 'workspace'),
    sessionDir: join(home, 'session'),
  };
}

/**
 * Host-only input directory for one run. It deliberately sits beside the
 * sandbox mounts, never inside the agent-writable workspace. The controller
 * exposes it through a nested read-only bind mount at `/workspace/inputs`.
 */
export function runInputsDirFor(dataRoot: string, userId: string, workspaceId: number, runId: string): string {
  assertSafeSegment(runId, 'runId');
  const { workspaceDir } = workspaceDirsFor(dataRoot, userId, workspaceId);
  return join(workspaceDir, '..', 'run-inputs', runId);
}

function assertSafeFileName(value: string): void {
  if (!value || value === '.' || value === '..' || basename(value) !== value || value.includes('\0')) {
    throw new Error(`input filename is unsafe: ${JSON.stringify(value)}`);
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Sandbox path is not a real directory: ${path}`);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Sandbox path is not a real directory: ${path}`);
}

async function writeExclusiveRegularFile(path: string, contents: string | Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

/**
 * Materialize immutable per-run inputs before the durable run becomes
 * queue-visible. A crashed/hostile sandbox can only mutate `workspace/` and
 * `session/`; it can neither plant links here nor race these writes.
 */
export async function prepareRunInputs(
  dataRoot: string,
  userId: string,
  workspaceId: number,
  runId: string,
  files: ReadonlyArray<{ name: string; buffer: Buffer }>,
): Promise<string | null> {
  if (files.length === 0) return null;
  const inputDir = runInputsDirFor(dataRoot, userId, workspaceId, runId);
  const parent = join(inputDir, '..');
  await ensureRealDirectory(parent);
  // The run id is random and unique. Refusing an existing leaf (including a
  // symlink) keeps retries/collisions fail-closed instead of overwriting it.
  await mkdir(inputDir, { mode: 0o700 });
  try {
    for (const file of files) {
      assertSafeFileName(file.name);
      await writeExclusiveRegularFile(join(inputDir, file.name), file.buffer);
    }
    return inputDir;
  } catch (err) {
    await rm(inputDir, { recursive: true, force: true });
    throw err;
  }
}

/** Remove only a never-published run's host-owned input staging directory. */
export async function discardRunInputs(
  dataRoot: string,
  userId: string,
  workspaceId: number,
  runId: string,
): Promise<void> {
  await rm(runInputsDirFor(dataRoot, userId, workspaceId, runId), { recursive: true, force: true });
}

/** Normalize the nested read-only bind destination without following links. */
export async function prepareRunInputMountpoint(workspaceDir: string): Promise<void> {
  const mountpoint = join(workspaceDir, 'inputs');
  try {
    const info = await lstat(mountpoint);
    if (info.isSymbolicLink()) {
      await unlink(mountpoint);
      await mkdir(mountpoint, { mode: 0o700 });
      return;
    }
    if (!info.isDirectory()) throw new Error('Sandbox input mountpoint is not a directory');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await mkdir(mountpoint, { mode: 0o700 });
  }
}

/**
 * Whether this run staged anything for `./inputs/`. The bind mount must be
 * decided by the staging directory itself, never by the attachment manifest:
 * the manifest lists user attachments only, while `inputs/` also carries the
 * launch conversation transcript, which is deliberately not an attachment
 * (conversation-transcript.ts). Deciding from the manifest would leave a
 * transcript-only run pointing at a path that was never mounted.
 *
 * Anything unexpected occupying that slot counts as present so
 * `assertRunInputsReady` rejects it loudly instead of silently skipping.
 */
export async function runInputsPresent(inputDir: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(inputDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return true;
  return (await readdir(inputDir)).length > 0;
}

export async function assertRunInputsReady(inputDir: string): Promise<void> {
  const info = await lstat(inputDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Sandbox run input staging is not a real directory');
  }
}

/** In-container path of the prompt file for one run. */
export function promptPathFor(runId: string): string {
  return `/session/prompt-${runId}.md`;
}

/** Ensure the workspace pair exists and drop this run's prompt file. */
export async function prepareRunDirs(
  dataRoot: string,
  userId: string,
  workspaceId: number,
  runId: string,
  prompt: string,
): Promise<RunDirs> {
  assertSafeSegment(runId, 'runId');
  const dirs = workspaceDirsFor(dataRoot, userId, workspaceId);
  // No container for this user is active while admission calls this function,
  // so validating each sandbox-writable root closes both persisted symlinks
  // and the stat/write race.
  await ensureRealDirectory(dirs.workspaceDir);
  await ensureRealDirectory(join(dirs.workspaceDir, 'artifacts'));
  await ensureRealDirectory(dirs.sessionDir);
  await writeExclusiveRegularFile(join(dirs.sessionDir, `prompt-${runId}.md`), prompt);
  return dirs;
}
