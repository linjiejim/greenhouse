/**
 * Offline copies of what the member last read, one JSON file per station + member + kind in the
 * app's documents directory (not the OS cache: it must survive low storage so a cold start without
 * a network still has something to show). Reads and writes never throw — a missing or corrupt
 * file reads as nothing. Signing out removes that member's files (`forgetMember`).
 */

import { Directory, File, Paths } from 'expo-file-system';
import { cacheFileName, cacheFilePrefix } from './cache-key';

const ROOT = 'offline';

function dir(): Directory {
  return new Directory(Paths.document, ROOT);
}

function file(name: string): File {
  return new File(dir(), name);
}

export async function readCache(stationId: string, memberId: string, kind: string): Promise<unknown> {
  try {
    const target = file(cacheFileName(stationId, memberId, kind));
    if (!target.exists) return null;
    return JSON.parse(await target.text()) as unknown;
  } catch {
    return null;
  }
}

export function writeCache(stationId: string, memberId: string, kind: string, value: unknown): void {
  try {
    const folder = dir();
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    file(cacheFileName(stationId, memberId, kind)).write(JSON.stringify(value));
  } catch {
    // an offline copy is a convenience
  }
}

/** Every offline copy of one station + member, or of the whole station (sign-out, removing it). */
export function forgetMember(stationId: string, memberId?: string): void {
  try {
    const folder = dir();
    if (!folder.exists) return;
    const prefix = cacheFilePrefix(stationId, memberId);
    for (const entry of folder.list()) {
      if (entry instanceof File && entry.name.startsWith(prefix)) entry.delete();
    }
  } catch {
    // best effort
  }
}
