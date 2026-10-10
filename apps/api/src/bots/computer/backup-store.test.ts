/**
 * Backup stores (backup-store.ts): a local folder (atomic, nothing left by a failed write,
 * keys that cannot escape it), an S3 bucket through s3-lite's multipart upload (16 MiB parts,
 * an aborted upload when anything fails), and the BOTS_COMPUTER_BACKUP_* settings.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { S3LiteClient } from '../../storage/s3-lite.js';
import {
  BackupStoreError,
  createLocalBackupStore,
  createS3BackupStore,
  loadBackupSettings,
  S3_PART_BYTES,
} from './backup-store.js';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('local folder store', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gh-store-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes, reads back and removes an object, tidying empty folders', async () => {
    const store = createLocalBackupStore(root);
    const data = randomBytes(300_000);
    expect(await store.write('u1/bkp_1/agent', Readable.from([data]))).toBe(data.length);
    expect((await readAll(await store.read('u1/bkp_1/agent'))).equals(data)).toBe(true);
    await store.remove('u1/bkp_1/agent');
    await store.remove('u1/bkp_1/agent'); // idempotent
    expect(readdirSync(root)).toEqual([]);
    await expect(store.read('u1/bkp_1/agent')).rejects.toMatchObject({ code: 'missing' });
  });

  it('leaves nothing behind when the stream fails half-way', async () => {
    const store = createLocalBackupStore(root);
    const failing = new PassThrough();
    const write = store.write('u1/bkp_2/agent', failing);
    failing.write(randomBytes(1000));
    setImmediate(() => failing.destroy(new Error('export died')));
    await expect(write).rejects.toThrow('export died');
    expect(existsSync(join(root, 'u1/bkp_2/agent'))).toBe(false);
    expect(readdirSync(join(root, 'u1/bkp_2'))).toEqual([]);
  });

  it('refuses keys that could leave its folder', async () => {
    const store = createLocalBackupStore(root);
    for (const key of ['../escape', 'u1/../../x', '/abs', 'u1//x', 'u1/bkp.1/agent', '']) {
      await expect(store.write(key, Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(BackupStoreError);
    }
  });
});

describe('S3 store', () => {
  /** An in-memory bucket behind the s3-lite surface the store uses. */
  function fakeBucket(opts: { failPart?: number } = {}) {
    const objects = new Map<string, Buffer>();
    const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
    const log: string[] = [];
    let partFailures = 0;
    const client: S3LiteClient = {
      putObject: async () => {},
      getObject: async (key) => objects.get(key) ?? null,
      getObjectStream: async (key) => (objects.has(key) ? Readable.from([objects.get(key)!]) : null),
      deleteObject: async (key) => {
        log.push(`delete ${key}`);
        objects.delete(key);
      },
      createMultipartUpload: async (key) => {
        const id = `up-${uploads.size + 1}`;
        uploads.set(id, { key, parts: new Map() });
        log.push(`create ${key}`);
        return id;
      },
      uploadPart: async (_key, uploadId, partNumber, body) => {
        if (partNumber === opts.failPart) {
          partFailures++;
          throw new Error('connection reset');
        }
        uploads.get(uploadId)!.parts.set(partNumber, Buffer.from(body));
        log.push(`part ${partNumber} ${body.length}`);
        return `"etag-${partNumber}"`;
      },
      completeMultipartUpload: async (key, uploadId, parts) => {
        const upload = uploads.get(uploadId)!;
        objects.set(key, Buffer.concat(parts.map((p) => upload.parts.get(p.partNumber)!)));
        uploads.delete(uploadId);
        log.push(`complete ${key} ${parts.map((p) => p.etag).join(',')}`);
      },
      abortMultipartUpload: async (key, uploadId) => {
        uploads.delete(uploadId);
        log.push(`abort ${key}`);
      },
    };
    return { client, objects, uploads, log, failures: () => partFailures };
  }

  it('uploads in 16 MiB parts (the last one shorter) and streams the object back', async () => {
    const bucket = fakeBucket();
    const store = createS3BackupStore(bucket.client, { prefix: 'bot-backups/', where: 's3://b/bot-backups/' });
    const data = randomBytes(2 * S3_PART_BYTES + 12345);
    // Delivered in odd-sized chunks, as a network stream would.
    const chunks: Buffer[] = [];
    for (let i = 0; i < data.length; i += 1_000_003) chunks.push(data.subarray(i, i + 1_000_003));
    expect(await store.write('u1/bkp_1/agent', Readable.from(chunks))).toBe(data.length);
    expect(bucket.log).toEqual([
      'create bot-backups/u1/bkp_1/agent',
      `part 1 ${S3_PART_BYTES}`,
      `part 2 ${S3_PART_BYTES}`,
      'part 3 12345',
      'complete bot-backups/u1/bkp_1/agent "etag-1","etag-2","etag-3"',
    ]);
    expect((await readAll(await store.read('u1/bkp_1/agent'))).equals(data)).toBe(true);
    await expect(store.read('u1/bkp_9/agent')).rejects.toMatchObject({ code: 'missing' });
    // An empty object is still one (empty) part.
    expect(await store.write('u1/bkp_1/browser', Readable.from([]))).toBe(0);
    expect(bucket.objects.get('bot-backups/u1/bkp_1/browser')?.length).toBe(0);
  });

  it('retries a failed part, and aborts the upload when it keeps failing', async () => {
    const bucket = fakeBucket({ failPart: 2 });
    const store = createS3BackupStore(bucket.client, { prefix: 'p/', where: 's3://b/p/' });
    await expect(store.write('u1/bkp_1/agent', Readable.from([randomBytes(S3_PART_BYTES + 10)]))).rejects.toThrow(
      'connection reset',
    );
    expect(bucket.failures()).toBe(3);
    expect(bucket.log.at(-1)).toBe('abort p/u1/bkp_1/agent');
    expect(bucket.objects.size).toBe(0);
    expect(bucket.uploads.size).toBe(0);
  }, 20_000);
});

describe('BOTS_COMPUTER_BACKUP_* settings', () => {
  const KEY = { PROVIDER_TOKEN_ENCRYPTION_KEY: 'a1'.repeat(32) };
  const S3 = {
    BOTS_COMPUTER_BACKUP_S3_ENDPOINT: 'https://s3.example.com',
    BOTS_COMPUTER_BACKUP_S3_BUCKET: 'greenhouse',
    BOTS_COMPUTER_BACKUP_S3_ACCESS_KEY_ID: 'AKID',
    BOTS_COMPUTER_BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
  };
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of ['PROVIDER_TOKEN_ENCRYPTION_KEY', 'VAULT_ENCRYPTION_KEY']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const load = (env: Record<string, string>) => {
    delete process.env.VAULT_ENCRYPTION_KEY;
    if (env.PROVIDER_TOKEN_ENCRYPTION_KEY)
      process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    else delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    return loadBackupSettings(env as NodeJS.ProcessEnv);
  };

  it('is off unless a folder or a bucket is set, with daily backups and two kept by default', () => {
    expect(load(KEY)).toEqual({ store: null, hours: 24, keep: 2, problem: null });
    const local = load({ ...KEY, BOTS_COMPUTER_BACKUP_DIR: 'data/bot-backups' });
    expect(local.store?.kind).toBe('local');
    expect(local.store?.where).toMatch(/data\/bot-backups$/);
    const s3 = load({ ...KEY, ...S3, BOTS_COMPUTER_BACKUP_HOURS: '6', BOTS_COMPUTER_BACKUP_KEEP: '3' });
    expect(s3).toMatchObject({ hours: 6, keep: 3, problem: null });
    expect(s3.store?.kind).toBe('s3');
    expect(s3.store?.where).toBe('s3://greenhouse/bot-backups/ (s3.example.com)');
    // A bucket wins over a folder.
    expect(load({ ...KEY, ...S3, BOTS_COMPUTER_BACKUP_DIR: 'x' }).store?.kind).toBe('s3');
  });

  it('turns backups off with the reason when something is wrong, never throwing', () => {
    const { BOTS_COMPUTER_BACKUP_S3_SECRET_ACCESS_KEY: _secret, ...partial } = S3;
    expect(load({ ...KEY, ...partial }).problem).toMatch(/missing BOTS_COMPUTER_BACKUP_S3_SECRET_ACCESS_KEY/);
    expect(load({ ...KEY, BOTS_COMPUTER_BACKUP_DIR: 'x', BOTS_COMPUTER_BACKUP_HOURS: '0' }).problem).toMatch(/HOURS/);
    expect(load({ ...KEY, BOTS_COMPUTER_BACKUP_DIR: 'x', BOTS_COMPUTER_BACKUP_KEEP: '99' }).problem).toMatch(/KEEP/);
    expect(load({ ...KEY, ...S3, BOTS_COMPUTER_BACKUP_S3_PREFIX: '../up' }).problem).toMatch(/PREFIX/);
    expect(load({ ...KEY, ...S3, BOTS_COMPUTER_BACKUP_S3_ENDPOINT: 'https://s3.example.com/path' }).problem).toMatch(
      /must not carry a path/,
    );
    // No vault key: nothing could seal a backup's key.
    const keyless = load({ BOTS_COMPUTER_BACKUP_DIR: 'x' });
    expect(keyless.store).toBeNull();
    expect(keyless.problem).toMatch(/VAULT_ENCRYPTION_KEY/);
  });
});
