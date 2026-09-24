/**
 * Chat file downloads — the files a tool hands back (export_data). The file
 * route needs the station's token, so the card passes its URL here instead of
 * opening a plain link (which would 401).
 */

import { authFetch } from './auth';

const CHAT_FILE_PREFIX = '/api/chat-files/';

export async function downloadChatFile(downloadUrl: string, filename: string): Promise<void> {
  // This attaches the station token, so it only ever fetches the station's own chat-file route.
  if (!downloadUrl.startsWith(CHAT_FILE_PREFIX)) throw new Error('invalid_chat_file_url');
  const res = await authFetch(downloadUrl);
  if (!res.ok) throw new Error(`http_${res.status}`);
  const objectUrl = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
