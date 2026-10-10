/**
 * The stream format of a computer backup (v1): chunked AES-256-GCM, the "STREAM"
 * construction (Hoang, Reyhanitabar, Rogaway, Vizár) —
 *
 *   header = "GHB1" ‖ nonce prefix (7 random bytes)
 *   record = flag (1 byte: 0 = more follow, 1 = the last) ‖ length (u32 BE) ‖ sealed
 *   sealed = AES-256-GCM(key, nonce = prefix ‖ u32 BE index ‖ flag, aad = header ‖ label)(chunk) ‖ tag
 *
 * - Every record is authenticated before a byte of it is released: a restore never
 *   feeds unverified data to tar.
 * - The last-record flag is part of the nonce: a stream cut at a record boundary, or
 *   one that carries on after its last record, fails as surely as a flipped bit.
 * - The label binds a stream to its backup and home (`<backup id>:<agent|browser>`),
 *   so one swapped for another fails authentication.
 *
 * The key is random per backup (backups.ts), stored sealed with the vault's key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

const MAGIC = Buffer.from('GHB1', 'ascii');
const PREFIX_BYTES = 7;
const HEADER_BYTES = MAGIC.length + PREFIX_BYTES;
const RECORD_HEAD_BYTES = 5;
const TAG_BYTES = 16;
/** Plaintext per record. */
export const BACKUP_CHUNK_BYTES = 1 << 20;
const MAX_RECORDS = 0xffffffff;

/** A backup stream that is not what its key and label wrote: tampered, truncated, swapped or foreign. */
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

function nonceFor(prefix: Buffer, index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, PREFIX_BYTES);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('A backup key is 32 bytes');
}

/** Chunks waiting to become a record, without copying them until one is complete. */
class Pending {
  private chunks: Buffer[] = [];
  length = 0;

  add(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** The first `n` bytes (n ≤ length), removed. */
  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const used = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, used);
      filled += used;
      if (used === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(used);
    }
    this.length -= n;
    return out;
  }

  /** Byte `i` without taking it. */
  at(i: number): number {
    for (const chunk of this.chunks) {
      if (i < chunk.length) return chunk[i]!;
      i -= chunk.length;
    }
    throw new RangeError('Pending.at past the end');
  }

  /** A big-endian u32 at `i` without taking it. */
  u32(i: number): number {
    return ((this.at(i) << 24) | (this.at(i + 1) << 16) | (this.at(i + 2) << 8) | this.at(i + 3)) >>> 0;
  }
}

/** Plaintext in, a v1 backup stream out. */
export function encryptBackupStream(key: Buffer, label: string): Transform {
  assertKey(key);
  const prefix = randomBytes(PREFIX_BYTES);
  const header = Buffer.concat([MAGIC, prefix]);
  const aad = Buffer.concat([header, Buffer.from(label, 'utf8')]);
  const pending = new Pending();
  let index = 0;

  const seal = (stream: Transform, chunk: Buffer, last: boolean): void => {
    if (index >= MAX_RECORDS) throw new BackupFormatError('A backup stream holds at most 2^32 records');
    const cipher = createCipheriv('aes-256-gcm', key, nonceFor(prefix, index, last));
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()]);
    const head = Buffer.alloc(RECORD_HEAD_BYTES);
    head[0] = last ? 1 : 0;
    head.writeUInt32BE(body.length, 1);
    stream.push(head);
    stream.push(body);
    index++;
  };

  return new Transform({
    construct(callback) {
      this.push(header);
      callback();
    },
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        pending.add(chunk);
        // Strictly more than a record's worth: the last record is only known at the end.
        while (pending.length > BACKUP_CHUNK_BYTES) seal(this, pending.take(BACKUP_CHUNK_BYTES), false);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        seal(this, pending.take(pending.length), true);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}

/** A v1 backup stream in, its plaintext out — each record only once it is authenticated. */
export function decryptBackupStream(key: Buffer, label: string): Transform {
  assertKey(key);
  const pending = new Pending();
  let prefix: Buffer | null = null;
  let aad: Buffer | null = null;
  let index = 0;
  let ended = false;

  const drain = (stream: Transform): void => {
    if (!prefix) {
      if (pending.length < HEADER_BYTES) return;
      const header = pending.take(HEADER_BYTES);
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupFormatError('Not a backup stream');
      prefix = header.subarray(MAGIC.length);
      aad = Buffer.concat([header, Buffer.from(label, 'utf8')]);
    }
    while (pending.length > 0) {
      if (ended) throw new BackupFormatError('Data after the last record of a backup stream');
      if (pending.length < RECORD_HEAD_BYTES) return;
      const flag = pending.at(0);
      const size = pending.u32(1);
      if (flag > 1 || size < TAG_BYTES || size > BACKUP_CHUNK_BYTES + TAG_BYTES) {
        throw new BackupFormatError('A malformed record in a backup stream');
      }
      if (pending.length < RECORD_HEAD_BYTES + size) return;
      pending.take(RECORD_HEAD_BYTES);
      const sealed = pending.take(size);
      const last = flag === 1;
      let plain: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, index, last));
        decipher.setAAD(aad!);
        decipher.setAuthTag(sealed.subarray(size - TAG_BYTES));
        plain = Buffer.concat([decipher.update(sealed.subarray(0, size - TAG_BYTES)), decipher.final()]);
      } catch {
        throw new BackupFormatError('A backup stream failed authentication (tampered, swapped or another key)');
      }
      index++;
      ended = last;
      if (plain.length > 0) stream.push(plain);
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        pending.add(chunk);
        drain(this);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      callback(ended ? null : new BackupFormatError('A backup stream ended early (truncated)'));
    },
  });
}
