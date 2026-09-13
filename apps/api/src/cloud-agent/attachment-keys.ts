import { sanitizeUploadName } from '../storage/filename.js';

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function attachmentKeyPrefix(userId: string): string {
  return `cloud-agent/attachments/${userId}/`;
}

/**
 * Mission attachments have one canonical shape. A prefix check alone is not an
 * ownership check: object stores and the local fallback both normalize path
 * segments, so `prefix + ../other-object` can escape the caller namespace.
 */
export function isOwnedAttachmentKey(userId: string, key: string): boolean {
  const prefix = attachmentKeyPrefix(userId);
  if (!key.startsWith(prefix) || key.includes('\\') || key.includes('\0')) return false;
  const suffix = key.slice(prefix.length);
  const segments = suffix.split('/');
  if (segments.length !== 2 || !UUID_SEGMENT.test(segments[0] ?? '')) return false;
  const filename = segments[1] ?? '';
  return filename.length > 0 && sanitizeUploadName(filename) === filename;
}
