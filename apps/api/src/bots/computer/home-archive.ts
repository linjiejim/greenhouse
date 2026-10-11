/**
 * A home as a gzip'd tar stream, the way both hosts take it out of a running
 * computer (a backup) and put it into a new one (a restore) — always as the uid
 * that owns it (`agent` / `browser`), never as root, so an archive can only ever
 * write where that uid could anyway.
 *
 * Backups leave out what rebuilds itself: download and build caches, Chromium's
 * caches, and its single-instance locks (stale on another machine). Moving a home
 * between two sandboxes (e2b-host.ts) is a different path that copies everything.
 */

import type { Readable } from 'node:stream';

import type { ComputerProcess, ComputerUser } from './host.js';

export const HOME_USERS: readonly ComputerUser[] = ['agent', 'browser'];

export function homeOf(user: ComputerUser): string {
  return `/home/${user}`;
}

/** Relative to the home (tar's member names start with `./`). */
const BACKUP_EXCLUDES: Record<ComputerUser, string[]> = {
  agent: ['./.cache', './.npm/_cacache', './.local/share/Trash'],
  browser: [
    './.cache',
    './chromium/Singleton*',
    './chromium/*/Cache',
    './chromium/*/Code Cache',
    './chromium/*/GPUCache',
    './chromium/*/DawnGraphiteCache',
    './chromium/*/DawnWebGPUCache',
    './chromium/*/Service Worker/CacheStorage',
    './chromium/*/Service Worker/ScriptCache',
    './chromium/ShaderCache',
    './chromium/GrShaderCache',
    './chromium/GraphiteDawnCache',
    './chromium/component_crx_cache',
  ],
};

/**
 * Stream one home out as a gzip'd tar. GNU tar exits 1 when a file changed while it
 * was read (a Bot still writing) — the archive is still complete; 2 is a failure.
 * A file this uid cannot read is skipped rather than fatal.
 */
export function homeExportArgv(user: ComputerUser): string[] {
  return [
    'tar',
    '-C',
    homeOf(user),
    '--ignore-failed-read',
    '--warning=no-file-changed',
    ...BACKUP_EXCLUDES[user].map((pattern) => `--exclude=${pattern}`),
    // Fast over small: the computer has a vCPU or two, and the stream is encrypted (incompressible) after this.
    '--use-compress-program=gzip -1',
    '-cf',
    '-',
    '.',
  ];
}

/** Unpack a gzip'd tar into a home; the home's own folders keep their owner and mode. */
export function homeImportArgv(user: ComputerUser): string[] {
  return ['tar', '-C', homeOf(user), '--no-overwrite-dir', '-xzpf', '-'];
}

/** Whether an export's exit code means a complete archive. */
export function exportSucceeded(code: number | null): boolean {
  return code === 0 || code === 1;
}

/**
 * Feed `data` to a running import (`sink`) and wait for it, within `timeoutMs`.
 * A source that fails (unreadable storage, a record that does not authenticate)
 * stops the import at once: only verified bytes ever reached it, and the half-
 * filled home is the caller's to throw away.
 */
export function pipeIntoImport(data: Readable, sink: ComputerProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: Error | null = null;
    let stderr = '';
    const fail = (err: Error) => {
      failure ??= err;
      data.unpipe();
      data.destroy();
      sink.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(new Error(`Restoring the home took longer than ${timeoutMs} ms`)), timeoutMs);
    data.once('error', fail);
    sink.stdin?.once('error', () => {});
    // Like a child's, a stream's 'close' waits for its output to be read: tar -x prints nothing, drain it anyway.
    sink.stdout?.resume();
    sink.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    sink.once('error', (err) => fail(err));
    sink.once('close', (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Unpacking the home failed (exit ${code}): ${stderr.slice(-300)}`));
      resolve();
    });
    if (sink.stdin) data.pipe(sink.stdin);
    else fail(new Error('The import has no stdin'));
  });
}
