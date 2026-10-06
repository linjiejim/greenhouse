/**
 * Download an authenticated server file (e.g. an `export_table` result at
 * /api/chat-files/<id>/content) into the cache and hand it to the system share
 * sheet — Save to Files, AirDrop, Mail, Numbers… The request goes through the
 * app's `api()` client, so the bearer token and the transparent 401 refresh
 * apply; the file name comes from Content-Disposition (falling back to the
 * caller's name or the id).
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { api } from '../api/client';

function fileNameFrom(disposition: string | null, fallback: string): string {
  if (disposition) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (star) return decodeURIComponent(star[1]);
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    if (plain) return plain[1];
  }
  return fallback;
}

/** Resolves false when the download fails (callers show their own error). */
export async function downloadAndShare(path: string, fallbackName = 'download'): Promise<boolean> {
  try {
    const res = await api(path);
    if (!res.ok) return false;
    const name = fileNameFrom(res.headers.get('content-disposition'), fallbackName).replace(/[\\/]/g, '_');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);
    if (!(await Sharing.isAvailableAsync())) return false;
    await Sharing.shareAsync(file.uri, { mimeType: res.headers.get('content-type') ?? undefined, dialogTitle: name });
    return true;
  } catch {
    return false;
  }
}
