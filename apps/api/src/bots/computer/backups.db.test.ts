/**
 * Computer backups (backups.ts) on real PostgreSQL, a fake host and a local folder store:
 * what a backup stores (encrypted, both homes, the key sealed with the vault key), when an
 * idle computer waits for one, how failures leave nothing behind, one backup per member
 * across API processes, retention, restores that never reuse an unreadable backup, wipes,
 * the sweep, and re-sealing keys under a new vault key.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type BotComputerRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { BackupFormatError } from './backup-format.js';
import { BackupStoreError, createLocalBackupStore } from './backup-store.js';
import {
  BACKUP_DEFER_MS,
  BACKUP_RETRY_MS,
  BACKUP_TIMEOUT_MS,
  backupObjectKey,
  createComputerBackups,
  rekeyBackupKeys,
} from './backups.js';
import { ComputerStartError, type ComputerHost, type ComputerProcess, type ComputerUser } from './host.js';

const PROVIDER_KEY = 'c4'.repeat(32);
const ENV = ['PROVIDER_TOKEN_ENCRYPTION_KEY', 'VAULT_ENCRYPTION_KEY', 'VAULT_ENCRYPTION_KEY_PREVIOUS'] as const;
const original = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

let db: DatabaseProvider;
let member: UserRow;
let root: string;
let now: number;
/** What each home "contains" (the export's output), and how the export ends. */
let homes: Record<ComputerUser, Buffer>;
let exportExit: number;
/** Holds an export open until released (a slow backup). */
let gate: Promise<void> | null;

beforeAll(() => {
  for (const name of ENV) delete process.env[name];
});
afterAll(() => {
  for (const name of ENV) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

beforeEach(async () => {
  process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = PROVIDER_KEY;
  delete process.env.VAULT_ENCRYPTION_KEY;
  delete process.env.VAULT_ENCRYPTION_KEY_PREVIOUS;
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  member = await createInternalTestUser(db, {
    email: `backup-${Date.now()}-${randomBytes(3).toString('hex')}@test.local`,
  });
  root = mkdtempSync(join(tmpdir(), 'gh-backups-'));
  now = Date.now();
  homes = { agent: randomBytes(2.5 * 1024 * 1024), browser: Buffer.from('cookies and a profile') };
  exportExit = 0;
  gate = null;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** tar -c as a fake process: writes the home, then exits once it has been read. */
function exportOf(user: ComputerUser): ComputerProcess {
  const proc = new EventEmitter() as EventEmitter & ComputerProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(proc, { stdin: null, stdout, stderr, exitCode: null, signalCode: null, kill: () => true });
  void (async () => {
    if (gate) await gate;
    stdout.end(homes[user]);
    stderr.end(exportExit ? 'tar: /home/agent: Cannot open' : '');
  })();
  stdout.once('end', () => setImmediate(() => proc.emit('close', exportExit, null)));
  return proc;
}

const host = {
  kind: 'e2b',
  exportHome: (_ref: string, user: ComputerUser) => exportOf(user),
} as unknown as ComputerHost;

function backups(opts: { keep?: number; hours?: number } = {}) {
  return createComputerBackups({
    db: db.botComputers,
    store: createLocalBackupStore(root),
    host: () => host,
    hours: opts.hours ?? 24,
    keep: opts.keep ?? 2,
    now: () => now,
  });
}

function computer(patch: Partial<BotComputerRow> = {}): BotComputerRow {
  return {
    user_id: member.id,
    container_name: 'sandbox-1',
    state: 'running',
    last_active_at: new Date(now - 20 * 60_000).toISOString(),
    last_started_at: new Date(now - 60 * 60_000).toISOString(),
    ...patch,
  } as BotComputerRow;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('taking a backup', () => {
  it('stores both homes encrypted, seals its key with the vault key, and restores exactly what it took', async () => {
    const taken = (await backups().start(computer(), 'admin'))!;
    expect(taken).toMatchObject({
      status: 'complete',
      reason: 'admin',
      store: 'local',
      driver: 'e2b',
      source_ref: 'sandbox-1',
    });
    expect(taken.key_enc).toMatch(/^gv1\.[0-9a-f]{8}\./);
    const stored = (['agent', 'browser'] as const).map((user) =>
      readFileSync(join(root, backupObjectKey(taken, user))),
    );
    expect(taken.bytes).toBe(stored[0]!.length + stored[1]!.length);
    // Nothing of a home is readable in the store.
    expect(stored[0]!.includes(homes.agent.subarray(1000, 1064))).toBe(false);
    expect(stored[1]!.includes(Buffer.from('cookies'))).toBe(false);

    const source = (await backups().restoreSource(member.id))!;
    expect(source).toMatchObject({ backupId: taken.id });
    expect((await readAll(await source.open('agent'))).equals(homes.agent)).toBe(true);
    expect((await readAll(await source.open('browser'))).toString()).toBe('cookies and a profile');
  });

  it('keeps an idle computer awake while its backup runs, and lets it sleep once the backup is fresh', async () => {
    const service = backups({ hours: 24 });
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    expect(await service.beforeSleep(computer(), 15)).toBe('wait'); // due: started
    expect(await service.beforeSleep(computer(), 15)).toBe('wait'); // under way
    release();
    expect(await service.start(computer(), 'idle')).toMatchObject({ status: 'complete', reason: 'idle' });
    expect(await service.beforeSleep(computer(), 15)).toBe('go'); // fresh
    now += 25 * 3_600_000;
    expect(await service.beforeSleep(computer({ last_active_at: new Date(now - 20 * 60_000).toISOString() }), 15)).toBe(
      'wait',
    );
  });

  it('a failed export leaves nothing behind, and the next try waits; nobody waits past the deferral', async () => {
    exportExit = 2;
    const service = backups();
    const failed = (await service.start(computer(), 'idle'))!;
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.error).toMatch(/exit 2.*Cannot open/);
    expect(existsSync(join(root, member.id))).toBe(false);
    expect(await service.beforeSleep(computer(), 15)).toBe('go'); // failing: not tried again at once
    now += BACKUP_RETRY_MS + 60_000;
    exportExit = 0;
    const idleNow = computer({ last_active_at: new Date(now - 20 * 60_000).toISOString() });
    expect(await service.beforeSleep(idleNow, 15)).toBe('wait');
    // Idle long past its time: it goes to sleep even though a backup is due or running.
    const longIdle = computer({ last_active_at: new Date(now - 15 * 60_000 - BACKUP_DEFER_MS - 1).toISOString() });
    expect(await service.beforeSleep(longIdle, 15)).toBe('go');
    expect(await service.start(idleNow, 'idle')).toMatchObject({ status: 'complete' }); // the one it started
  });

  it('takes one backup per member at a time, across API processes', async () => {
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    const first = backups().start(computer(), 'idle');
    // Another process sees the running row.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await backups().start(computer(), 'idle')).toBeNull();
    expect(await backups().beforeSleep(computer(), 15)).toBe('wait');
    release();
    expect(await first).toMatchObject({ status: 'complete' });
  });

  it('keeps the newest complete backups and deletes older ones with their objects', async () => {
    const service = backups({ keep: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await service.start(computer(), 'admin'))!.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const left = await db.botComputers.listBackups(member.id);
    expect(left.map((b) => b.id)).toEqual([ids[2], ids[1]]);
    expect(existsSync(join(root, member.id, ids[0]!))).toBe(false);
  });
});

describe('restoring', () => {
  it('never uses a tampered or missing backup again, and falls back to the one before it', async () => {
    const service = backups({ keep: 3 });
    const older = (await service.start(computer(), 'admin'))!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = (await service.start(computer(), 'admin'))!;
    // A flipped byte in the newest backup's agent home.
    const path = join(root, backupObjectKey(newer, 'agent'));
    const bytes = readFileSync(path);
    bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
    writeFileSync(path, bytes);

    const first = (await service.restoreSource(member.id))!;
    expect(first.backupId).toBe(newer.id);
    await expect(readAll(await first.open('agent'))).rejects.toBeInstanceOf(BackupFormatError);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await db.botComputers.getBackup(newer.id)).toMatchObject({ status: 'failed' });

    rmSync(join(root, backupObjectKey(older, 'browser')));
    const second = (await service.restoreSource(member.id))!;
    expect(second.backupId).toBe(older.id);
    await expect(second.open('browser')).rejects.toBeInstanceOf(BackupStoreError);
    expect(await service.restoreSource(member.id)).toBeNull();
  });

  it('fails the start rather than start empty when a backup’s key cannot be opened', async () => {
    await backups().start(computer(), 'admin');
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = 'd5'.repeat(32);
    const failure = await backups()
      .restoreSource(member.id)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ComputerStartError);
    expect((failure as ComputerStartError).reason).toBe('restore_failed');
  });

  it('tells a run that began from a backup, and only that run', async () => {
    const service = backups();
    const taken = (await service.start(computer(), 'admin'))!;
    const startedAt = new Date(Date.now() - 1000).toISOString();
    await service.restored(taken.id);
    expect(await service.restoredInto(member.id, startedAt)).toBe(taken.completed_at);
    expect(await service.restoredInto(member.id, new Date(Date.now() + 60_000).toISOString())).toBeNull();
  });
});

describe('deleting and sweeping', () => {
  it('a wipe deletes every backup and its objects', async () => {
    const service = backups();
    await service.start(computer(), 'admin');
    await service.deleteAll(member.id);
    expect(await db.botComputers.listBackups(member.id)).toEqual([]);
    expect(existsSync(join(root, member.id))).toBe(false);
  });

  it('ends a backup whose process died and deletes those whose member is gone', async () => {
    const stuck = (await db.botComputers.startBackup({
      id: `bkp_stuck${randomBytes(4).toString('hex')}`,
      user_id: member.id,
      reason: 'idle',
      store: 'local',
      key_enc: 'gv1.00000000.x',
      driver: 'e2b',
      source_ref: 'sandbox-1',
    }))!;
    const orphan = (await db.botComputers.startBackup({
      id: `bkp_orphan${randomBytes(4).toString('hex')}`,
      user_id: `usr_gone_${randomBytes(4).toString('hex')}`,
      reason: 'idle',
      store: 'local',
      key_enc: 'gv1.00000000.x',
      driver: 'e2b',
      source_ref: 'sandbox-2',
    }))!;
    now += BACKUP_TIMEOUT_MS + 16 * 60_000;
    await backups().sweep();
    expect(await db.botComputers.getBackup(stuck.id)).toMatchObject({ status: 'failed' });
    expect(await db.botComputers.getBackup(orphan.id)).toBeUndefined();
  });
});

describe('rotating the vault key', () => {
  it('re-seals every backup key under the new key; restores need only the new one', async () => {
    const taken = (await backups().start(computer(), 'admin'))!;
    process.env.VAULT_ENCRYPTION_KEY = 'e6'.repeat(32);
    const dry = await rekeyBackupKeys(db.botComputers, { dryRun: true });
    expect(dry.rekeyed).toBeGreaterThanOrEqual(1);
    expect((await db.botComputers.getBackup(taken.id))!.key_enc).toBe(taken.key_enc);
    const result = await rekeyBackupKeys(db.botComputers);
    expect(result.unreadable).not.toContain(taken.id);
    expect((await db.botComputers.getBackup(taken.id))!.key_enc).not.toBe(taken.key_enc);
    delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    const source = (await backups().restoreSource(member.id))!;
    expect((await readAll(await source.open('browser'))).toString()).toBe('cookies and a profile');
  });
});
