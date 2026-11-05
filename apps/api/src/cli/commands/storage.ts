/**
 * `storage` — object storage operations.
 *
 *   storage push-local [--dry-run] [--json]
 *
 * Copies every object stored on local disk (UPLOADS_DIR) into the configured object
 * backend under the key it would have had there: flat chat/generated image ids under
 * their upload key, drive files (plugin objects included) under their drive key. Run it
 * once when a deployment moves from a disk to COS or S3: drive reads have no local
 * fallback, so files left on disk would stop opening. An object already in the bucket
 * with the same size is skipped; nothing is deleted locally.
 */
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import chalk from 'chalk';
import { UPLOADS_DIR } from '../../paths.js';
import {
  contentTypeForId,
  driveObjectPrefix,
  headObjectSize,
  isValidUploadId,
  objectStorageBackend,
  putObjectStreamAtKey,
  uploadObjectKey,
} from '../../storage/uploads.js';
import { contentTypeForObjectKey } from '../../storage/plugin-objects.js';
import { dim, flagBool, heading, parseFlags } from './shared.js';

export interface LocalObject {
  path: string;
  key: string;
  size: number;
  contentType: string;
}

/** Walk UPLOADS_DIR into object keys; `skipped` lists files with no object key (left alone). */
export function localObjects(root = UPLOADS_DIR): { objects: LocalObject[]; skipped: string[] } {
  const objects: LocalObject[] = [];
  const skipped: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return { objects, skipped };
  }
  const drive = driveObjectPrefix();
  for (const entry of entries.sort()) {
    const path = resolve(root, entry);
    const rel = relative(root, path).split(sep).join('/');
    if (rel.split('/').some((part) => part.startsWith('.'))) continue;
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    if (!rel.includes('/') && isValidUploadId(rel)) {
      objects.push({ path, key: uploadObjectKey(rel), size: stat.size, contentType: contentTypeForId(rel) });
    } else if (rel.startsWith(drive)) {
      objects.push({ path, key: rel, size: stat.size, contentType: contentTypeForObjectKey(rel) });
    } else skipped.push(rel);
  }
  return { objects, skipped };
}

async function pushLocal(flags: Record<string, string | boolean>): Promise<number> {
  const dryRun = flagBool(flags, 'dry-run');
  const json = flagBool(flags, 'json');
  const backend = objectStorageBackend();
  if (backend === 'local') {
    console.error(chalk.red('No object backend configured: set TENCENT_CLOUD_COS_* or STORAGE_S3_* first.'));
    return 1;
  }
  const { objects, skipped } = localObjects();
  let copied = 0;
  let present = 0;
  let bytes = 0;
  const failed: Array<{ key: string; error: string }> = [];
  for (const object of objects) {
    const existing = await headObjectSize(object.key).catch(() => null);
    if (existing === object.size) {
      present += 1;
      continue;
    }
    if (dryRun) {
      copied += 1;
      bytes += object.size;
      continue;
    }
    try {
      const body = Readable.toWeb(createReadStream(object.path)) as ReadableStream<Uint8Array>;
      await putObjectStreamAtKey(object.key, body, object.size, object.contentType);
      copied += 1;
      bytes += object.size;
    } catch (err) {
      failed.push({ key: object.key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const summary = { backend, dryRun, local: objects.length, present, copied, bytes, failed, skipped };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(heading(`Local objects → ${backend}${dryRun ? ' (dry run)' : ''}`));
    console.log(`  local files      ${objects.length}`);
    console.log(`  already present  ${present}`);
    console.log(`  ${dryRun ? 'would copy' : 'copied'}       ${copied} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    if (skipped.length) console.log(`  not objects      ${skipped.length} ${dim('(left alone)')}`);
    for (const f of failed) console.log(chalk.red(`  failed ${f.key}: ${f.error}`));
  }
  return failed.length ? 1 : 0;
}

export async function run(args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const sub = positionals[0];
  if (sub === 'push-local') return pushLocal(flags);
  console.log(`${heading('storage')}
  storage push-local [--dry-run] [--json]   Copy local-disk objects into the configured COS / S3 bucket`);
  return sub ? 1 : 0;
}
