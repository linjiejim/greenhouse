/** Both homes are encrypted before storage. No archive is unpacked before GCM authentication. */
import { and, desc, eq } from 'drizzle-orm';
import { computerBackups, getDb, newId, type AgentComputer } from '@greenhouse/db';
import type { SandboxClient, SandboxStream } from '@greenhouse/providers';
import { logger } from '@greenhouse/utils/logger';
import { encrypt, decrypt } from '@greenhouse/utils/crypto';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ProvidersService } from '../../providers/service.js';
import { ApiError, conflict, notFound } from '../../http/errors.js';
import { runToEnd } from './streams.js';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_OBJECT = 120 * 1024 * 1024;
/** A 32 MiB home also needs time to cross the hosted bridge on a slow connection. */
const TIMEOUT = 10 * 60_000;
const USERS = ['agent', 'browser'] as const;
export const QUIESCE_SCRIPT = `import os, signal
protected = {1, os.getpid()}
pid = os.getppid()
while pid > 1 and pid not in protected:
 protected.add(pid)
 try:
  with open('/proc/'+str(pid)+'/status') as info:
   pid = next(int(line.split()[1]) for line in info if line.startswith('PPid:'))
 except (ProcessLookupError, FileNotFoundError): break
for item in os.listdir('/proc'):
 if not item.isdigit() or int(item) in protected: continue
 try:
  if os.stat('/proc/'+item).st_uid == os.getuid(): os.kill(int(item), signal.SIGSTOP)
 except (ProcessLookupError, FileNotFoundError): pass
`;

const EXPORT = [
  'timeout',
  '--kill-after=5',
  String(TIMEOUT / 1000),
  'tar',
  '--ignore-failed-read',
  '--warning=no-file-changed',
  '--exclude=./.cache',
  '--exclude=./chromium/Singleton*',
  '--exclude=./chromium/*/Cache',
  '--exclude=./chromium/*/Code Cache',
  '--exclude=./chromium/component_crx_cache',
  '-czf',
  '-',
  '.',
];
// Validate every entry before changing the home. Do not follow pre-existing symlinks on restore.
export const RESTORE_SCRIPT = `import io, os, pathlib, shutil, sys, tarfile, tempfile
home = pathlib.Path.cwd()
raw = sys.stdin.buffer.read(${MAX_ARCHIVE + 1})
if len(raw) > ${MAX_ARCHIVE}: raise ValueError('Archive too large')
with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
 entries = archive.getmembers()
 if len(entries) > 100000 or sum(x.size for x in entries) > 256*1024*1024: raise ValueError('Home too large')
 for entry in entries:
  path = pathlib.PurePosixPath(entry.name)
  if path.is_absolute() or '..' in path.parts or not (entry.isfile() or entry.isdir() or entry.issym()): raise ValueError('Unsafe archive entry')
  if entry.issym():
   target = pathlib.PurePosixPath(entry.linkname)
   if target.is_absolute() or '..' in target.parts: raise ValueError('Unsafe archive link')
 stage = pathlib.Path(tempfile.mkdtemp(prefix='.gh-restore-', dir=home))
 try:
  archive.extractall(stage, filter='data')
  for old in home.iterdir():
   if old == stage: continue
   if old.is_dir() and not old.is_symlink(): shutil.rmtree(old)
   else: old.unlink()
  for item in stage.iterdir(): shutil.move(str(item), home / item.name)
 finally: shutil.rmtree(stage, ignore_errors=True)
`;

async function bytesOf(stream: SandboxStream, timeoutMs: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  let failure: Error | undefined;
  stream.output.on('data', (part: Buffer) => {
    size += part.length;
    if (size > MAX_ARCHIVE) {
      failure = new Error('The compressed home exceeds 32 MiB.');
      stream.kill();
    } else parts.push(part);
  });
  stream.output.on('error', (error: Error) => {
    failure = error;
    stream.kill();
  });
  stream.errors.on('error', (error: Error) => {
    failure = error;
    stream.kill();
  });
  stream.errors.resume();
  stream.input.end();
  const timer = setTimeout(() => {
    failure = new Error('The backup timed out.');
    stream.kill();
  }, timeoutMs);
  try {
    const code = await stream.exited;
    if (failure) throw failure;
    if (code === null) return null;
    if (code !== 0 && code !== 1) throw new Error(`The home could not be archived (exit ${code}).`);
    return Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
  }
}

export function createComputerBackups(deps: { providers: ProvidersService; encryptionKey: Buffer }) {
  let active = 0;
  const rows = (computerId: string) =>
    getDb()
      .select()
      .from(computerBackups)
      .where(eq(computerBackups.computerId, computerId))
      .orderBy(desc(computerBackups.id));
  const aad = (row: AgentComputer, id: string) => `computer-backup:${row.ownerId}:${row.id}:${id}`;
  const service = {
    async list(computerId: string) {
      return (await rows(computerId)).map((r) => ({
        id: r.id,
        created_at: r.createdAt,
        bytes: r.bytes,
        status: r.status,
        error: r.error,
      }));
    },
    async take(row: AgentComputer, client: SandboxClient, required = true) {
      if (active >= 2)
        throw conflict('backup_busy', 'Two computer backups are already in progress. Try again shortly.');
      active++;
      try {
        const storage = await deps.providers.resolve('storage', { memberId: row.ownerId, personal: false });
        if (!storage) {
          if (required) throw new ApiError(503, 'backup_unavailable', 'Set up storage before backing up a computer.');
          return;
        }
        const id = newId('computerBackup');
        const objectKey = `computer-backups/${row.ownerId}/${row.id}/${id}`;
        let stage = 'agent';
        try {
          const archives: Record<string, string> = {};
          for (const user of USERS) {
            stage = user;
            const deadline = Date.now() + TIMEOUT;
            const read = () =>
              bytesOf(
                client.stream(row.sandboxRef, { user, cwd: `/home/${user}`, argv: EXPORT }),
                Math.max(1, deadline - Date.now()),
              );
            // A dropped transport may be retried: nothing was written, and no partial archive is kept.
            const archive = (await read()) ?? (await read());
            if (!archive) throw new Error('The archive connection ended before the command exited.');
            archives[user] = archive.toString('base64');
          }
          stage = 'storage';
          const sealed = Buffer.from(encrypt(JSON.stringify(archives), deps.encryptionKey, aad(row, id)));
          await storage.client.put(objectKey, sealed, { contentType: 'application/octet-stream' });
          await getDb().insert(computerBackups).values({
            id,
            computerId: row.id,
            providerId: storage.instance.id,
            objectKey,
            status: 'complete',
            bytes: sealed.length,
          });
          await service
            .prune(row.id)
            .catch(() => logger.warn('[computers] backup retention will retry', { computer: row.id }));
        } catch (error) {
          logger.warn('[computers] backup failed', { computer: row.id, stage, error: toErrorMessage(error) });
          await storage.client.delete(objectKey).catch(() => undefined);
          await getDb().insert(computerBackups).values({
            id,
            computerId: row.id,
            providerId: storage.instance.id,
            objectKey,
            status: 'failed',
            error: 'The home could not be backed up. Check storage and the 32 MiB limit per home.',
          });
          await service
            .prune(row.id)
            .catch(() => logger.warn('[computers] backup retention will retry', { computer: row.id }));
          throw new ApiError(502, 'backup_failed', 'The home could not be backed up.');
        }
      } finally {
        active--;
      }
    },
    async prune(computerId: string, all = false) {
      const backups = await rows(computerId);
      let complete = 0;
      let failed = 0;
      for (const row of backups) {
        if (!all && (row.status === 'complete' ? ++complete <= 3 : ++failed <= 3)) continue;
        const storage = await deps.providers.byId('storage', row.providerId, { personal: false });
        if (!storage) throw new ApiError(503, 'backup_unavailable', 'The backup storage is unavailable.');
        await storage.client.delete(row.objectKey);
        await getDb().delete(computerBackups).where(eq(computerBackups.id, row.id));
      }
    },
    async restore(row: AgentComputer, client: SandboxClient, id: string) {
      const [backup] = await getDb()
        .select()
        .from(computerBackups)
        .where(
          and(
            eq(computerBackups.id, id),
            eq(computerBackups.computerId, row.id),
            eq(computerBackups.status, 'complete'),
          ),
        );
      if (!backup) throw notFound('Backup');
      const storage = await deps.providers.byId('storage', backup.providerId, {
        memberId: row.ownerId,
        personal: false,
      });
      const stored = await storage?.client.get(backup.objectKey);
      if (!stored) throw new ApiError(503, 'backup_unavailable', 'The backup is unavailable.');
      const reader = stored.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      const deadline = Date.now() + TIMEOUT;
      try {
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const part = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(conflict('backup_invalid', 'The backup download timed out.')),
                Math.max(1, deadline - Date.now()),
              );
            }),
          ]).finally(() => clearTimeout(timer));
          if (part.done) break;
          size += part.value.length;
          if (size > MAX_OBJECT) throw conflict('backup_invalid', 'The backup is too large.');
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel();
      }
      let archives: Record<string, string>;
      try {
        archives = JSON.parse(decrypt(Buffer.concat(chunks).toString(), deps.encryptionKey, aad(row, id)));
      } catch {
        throw conflict('backup_invalid', 'The backup failed authentication.');
      }
      for (const user of USERS) {
        if (typeof archives[user] !== 'string') throw conflict('backup_invalid', 'The backup is incomplete.');
      }
      for (const user of USERS) {
        const paused = await runToEnd(
          client.stream(row.sandboxRef, { user, argv: ['python3', '-c', QUIESCE_SCRIPT] }),
          null,
          {
            timeoutMs: 10_000,
            maxOutputBytes: 4096,
          },
        );
        if (paused.code !== 0) throw conflict('backup_restore_failed', 'The computer could not pause its processes.');
      }
      for (const user of USERS) {
        if (typeof archives[user] !== 'string') throw conflict('backup_invalid', 'The backup is incomplete.');
        const result = await runToEnd(
          client.stream(row.sandboxRef, {
            user,
            cwd: `/home/${user}`,
            argv: ['timeout', '--kill-after=5', String(TIMEOUT / 1000), 'python3', '-c', RESTORE_SCRIPT],
          }),
          Buffer.from(archives[user], 'base64'),
          { timeoutMs: TIMEOUT, maxOutputBytes: 4096 },
        );
        if (result.code !== 0) throw conflict('backup_restore_failed', 'The home could not be restored.');
      }
    },
  };
  return service;
}
