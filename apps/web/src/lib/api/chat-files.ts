/**
 * Chat attachments — any file type, bound to a session.
 *
 * Stays on raw authFetch (not hc): the request body is FormData, and the hc
 * client conventions (see ./client.ts) reserve hc for JSON.
 *
 * Images do NOT come through here — they keep `/api/upload`'s flat public-read
 * id because `<img src>` cannot send a bearer token. Everything else is an
 * authenticated, session-scoped handle, so downloads must go through
 * `downloadAuthenticatedFile`, never a bare `<a href>`.
 */

import { authFetch } from '../auth';

/** Mirrors the server limits in apps/api/src/routes/chat-files.ts. */
export const MAX_CHAT_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_CHAT_FILES_PER_TURN = 10;

/** Handle returned on upload — the id is what a dispatch card carries. */
export interface ChatFileRef {
  id: string;
  name: string;
  content_type?: string;
  size?: number;
}

export async function uploadChatFile(sessionId: string, file: File): Promise<ChatFileRef> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('session_id', sessionId);
  const res = await authFetch('/api/chat-files/upload', { method: 'POST', body: formData });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Upload failed: ${res.status}`);
  }
  return (await res.json()).file;
}

/** Authenticated download endpoint — fetch via downloadAuthenticatedFile. */
export function chatFileDownloadUrl(id: string): string {
  return `/api/chat-files/${encodeURIComponent(id)}/content`;
}
