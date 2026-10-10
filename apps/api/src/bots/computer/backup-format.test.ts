/**
 * The backup stream format (backup-format.ts): round trips at every size that
 * matters around a record, and every way a stream can be wrong — a flipped bit,
 * a cut, a swapped or reordered record, another key or label, trailing data —
 * fails, and never before releasing only authenticated bytes.
 */

import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';

import { BACKUP_CHUNK_BYTES, BackupFormatError, decryptBackupStream, encryptBackupStream } from './backup-format.js';

const KEY = randomBytes(32);
const LABEL = 'bkp_1:agent';

async function collect(source: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

/** `data` in `pieces`-sized writes (the network never delivers whole records). */
function source(data: Buffer, pieces = 65_536): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += pieces) chunks.push(data.subarray(i, i + pieces));
  return Readable.from(chunks);
}

async function seal(plain: Buffer, key = KEY, label = LABEL): Promise<Buffer> {
  return await collect(source(plain).pipe(encryptBackupStream(key, label)));
}

/** Decrypt, returning what came out before the stream failed (if it did) and the error. */
async function open(sealed: Buffer, key = KEY, label = LABEL, pieces = 4096): Promise<{ out: Buffer; error: unknown }> {
  const out: Buffer[] = [];
  let error: unknown = null;
  try {
    await pipeline(
      source(sealed, pieces),
      decryptBackupStream(key, label),
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          out.push(chunk);
          cb();
        },
      }),
    );
  } catch (err) {
    error = err;
  }
  return { out: Buffer.concat(out), error };
}

/** Byte offsets of each record in a sealed stream: [start, end) including its 5-byte head. */
function records(sealed: Buffer): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 11;
  while (at < sealed.length) {
    const size = sealed.readUInt32BE(at + 1);
    spans.push([at, at + 5 + size]);
    at += 5 + size;
  }
  return spans;
}

describe('backup stream format', () => {
  it('round-trips empty, small, record-sized and multi-record streams', async () => {
    for (const size of [
      0,
      1,
      1000,
      BACKUP_CHUNK_BYTES - 1,
      BACKUP_CHUNK_BYTES,
      BACKUP_CHUNK_BYTES + 1,
      3.5 * BACKUP_CHUNK_BYTES,
    ]) {
      const plain = randomBytes(size);
      const sealed = await seal(plain);
      expect(sealed.subarray(0, 4).toString()).toBe('GHB1');
      const { out, error } = await open(sealed);
      expect(error).toBeNull();
      expect(out.equals(plain)).toBe(true);
    }
  });

  it('adds 21 bytes per record and leaves no plaintext visible', async () => {
    const plain = Buffer.alloc(2 * BACKUP_CHUNK_BYTES + 10, 'a');
    const sealed = await seal(plain);
    expect(records(sealed)).toHaveLength(3);
    expect(sealed.length).toBe(11 + plain.length + 3 * (5 + 16));
    expect(sealed.includes(Buffer.alloc(64, 'a'))).toBe(false);
    // A fresh nonce prefix each time: the same plaintext never seals the same way.
    expect((await seal(plain)).equals(sealed)).toBe(false);
  });

  it('fails a flipped bit at the record, having released only the records before it', async () => {
    const plain = randomBytes(3 * BACKUP_CHUNK_BYTES);
    const sealed = await seal(plain);
    const [, second] = records(sealed);
    const tampered = Buffer.from(sealed);
    tampered[second![0] + 100] ^= 0x01;
    const { out, error } = await open(tampered);
    expect(error).toBeInstanceOf(BackupFormatError);
    expect(out.equals(plain.subarray(0, BACKUP_CHUNK_BYTES))).toBe(true);
  });

  it('fails a stream cut anywhere — mid-record, or exactly between records', async () => {
    const plain = randomBytes(2 * BACKUP_CHUNK_BYTES + 500);
    const sealed = await seal(plain);
    const spans = records(sealed);
    for (const cut of [5, 11, spans[0]![1], spans[1]![1], sealed.length - 1]) {
      const { error } = await open(sealed.subarray(0, cut));
      expect(error, `cut at ${cut}`).toBeInstanceOf(BackupFormatError);
    }
  });

  it('fails a forged "last" flag, reordered records, and data after the last record', async () => {
    const plain = randomBytes(2 * BACKUP_CHUNK_BYTES + 500);
    const sealed = await seal(plain);
    const [first, second, third] = records(sealed);
    // Stop after the first record by marking it the last one.
    const early = Buffer.from(sealed.subarray(0, first![1]));
    early[first![0]] = 1;
    expect((await open(early)).error).toBeInstanceOf(BackupFormatError);
    const header = sealed.subarray(0, 11);
    const slice = ([a, b]: [number, number]) => sealed.subarray(a, b);
    const swapped = Buffer.concat([header, slice(second!), slice(first!), slice(third!)]);
    expect((await open(swapped)).error).toBeInstanceOf(BackupFormatError);
    const trailing = Buffer.concat([sealed, slice(third!)]);
    expect((await open(trailing)).error).toBeInstanceOf(BackupFormatError);
  });

  it('opens only with its own key and label (another backup, or the other home)', async () => {
    const sealed = await seal(randomBytes(5000));
    expect((await open(sealed, randomBytes(32))).error).toBeInstanceOf(BackupFormatError);
    expect((await open(sealed, KEY, 'bkp_1:browser')).error).toBeInstanceOf(BackupFormatError);
    expect((await open(sealed, KEY, 'bkp_2:agent')).error).toBeInstanceOf(BackupFormatError);
    expect((await open(Buffer.from('not a backup at all'))).error).toBeInstanceOf(BackupFormatError);
  });

  it('decrypts whatever the network delivers, one byte at a time included', async () => {
    const plain = randomBytes(BACKUP_CHUNK_BYTES + 77);
    const sealed = await seal(plain);
    const tail = await open(sealed.subarray(0, 11 + 5 + 16 + 64), KEY, LABEL, 1);
    expect(tail.error).toBeInstanceOf(BackupFormatError);
    const { out, error } = await open(sealed, KEY, LABEL, 1_000_003);
    expect(error).toBeNull();
    expect(out.equals(plain)).toBe(true);
  });
});
