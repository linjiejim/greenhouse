/** Authenticated preview cache: a file downloaded for Quick Look and the share sheet.
 * Downloads use api() for station-bound credentials and refresh; each preview
 * owns a unique directory and deletes it when closed. No user-visible save is required.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { api } from '../api/client';
import { getTokenStationId } from '../api/token-storage';

function fileNameFrom(disposition: string | null, fallback: string): string {
  if (disposition) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (star) {
      try {
        return decodeURIComponent(star[1]);
      } catch {
        /* use plain name */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    if (plain) return plain[1];
  }
  return fallback;
}

export interface CachedFile {
  uri: string;
  name: string;
  mimeType?: string;
  previewText?: string;
  previewTruncated?: boolean;
  dispose(): void;
}

/** Private, per-preview cache; never replaces another open file with the same name. */
export async function downloadFile(path: string, fallbackName = 'download', signal?: AbortSignal): Promise<CachedFile> {
  const station = getTokenStationId();
  const res = await api(path, { signal });
  if (!res.ok) throw Object.assign(new Error('download_failed'), { status: res.status });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (signal?.aborted || station !== getTokenStationId()) throw new Error('download_cancelled');
  const name = fileNameFrom(res.headers.get('content-disposition'), fallbackName)
    .replace(/[\\/]/g, '_')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('');
  const dir = new Directory(Paths.cache, `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dir.create();
  const file = new File(dir, name && name !== '.' && name !== '..' ? name : 'download');
  const dispose = () => {
    if (dir.exists) dir.delete();
  };
  try {
    file.create();
    file.write(bytes);
  } catch (error) {
    dispose();
    throw error;
  }
  // Quick Look renders small CSVs at spreadsheet-page scale. Text formats are
  // more readable as selectable, wrapping native text; no HTML/script execution.
  let previewText: string | undefined;
  let previewTruncated = false;
  if (/\.(txt|md|csv|tsv|json|log|yaml|yml|js|ts|css|py|sh)$/i.test(file.name)) {
    try {
      const content = await file.text();
      previewText = content.slice(0, 50_000);
      previewTruncated = content.length > previewText.length;
    } catch {
      /* Quick Look / share fallback */
    }
  }
  if (signal?.aborted || station !== getTokenStationId()) {
    dispose();
    throw new Error('download_cancelled');
  }
  return {
    uri: file.uri,
    name: file.name,
    mimeType: res.headers.get('content-type') ?? undefined,
    previewText,
    previewTruncated,
    dispose,
  };
}

/** A file name from a title: control characters and path symbols become spaces, at most 80 characters. */
export function fileStem(title: string | undefined, fallback: string): string {
  const stem = [...(title ?? '')]
    .map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return stem || fallback;
}

/** Write `content` to the cache as `name` and open the share sheet; false when it could not. */
export async function shareTextFile(name: string, content: string, mimeType: string): Promise<boolean> {
  try {
    const file = new File(Paths.cache, name.replace(/[\\/]/g, '_'));
    if (file.exists) file.delete();
    file.create();
    file.write(content);
    if (!(await Sharing.isAvailableAsync())) return false;
    await Sharing.shareAsync(file.uri, {
      mimeType,
      dialogTitle: name,
      UTI: mimeType === 'text/html' ? 'public.html' : undefined,
    });
    return true;
  } catch {
    return false;
  }
}
