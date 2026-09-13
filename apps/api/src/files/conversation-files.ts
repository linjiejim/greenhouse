/**
 * Resolve a file reference the MODEL supplied to bytes from this conversation.
 *
 * There are two stores behind a chat, for a reason that is not going away:
 * ordinary attachments get an authenticated `chat_files` handle, while images
 * stay on the flat public-read `/api/upload/:id` path because `<img src>`
 * cannot send a bearer token. Tools that accept "the files in this
 * conversation" have to span both, and every tool that spanned only the first
 * one told the user their picture did not exist — on dev, five refusals across
 * two conversations, all of them "No such attachment" for an image sitting
 * right there in the transcript.
 *
 * The session bound is the authorization, exactly as in `read_attachment`: the
 * id comes from the model, so an id copied out of another conversation must not
 * resolve here. That check differs per store — a row lookup for chat files, a
 * transcript search for images — which is precisely why it belongs in one
 * module rather than in each caller.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import { getObjectAtKey, getUpload, isValidUploadId } from '../storage/uploads.js';

/** A file this conversation really owns, with its bytes not yet read. */
export interface ConversationFile {
  /** The reference as the model wrote it, for error messages that match its input. */
  ref: string;
  name: string;
  content_type: string;
  size: number;
  read: () => Promise<Buffer | null>;
}

export type ResolveResult =
  | { ok: true; files: ConversationFile[] }
  /** `missing` holds the refs as given, so the caller can name them verbatim. */
  | { ok: false; missing: string[] };

/**
 * Strip the ways a model writes an image reference down to the bare id.
 *
 * `generate_image` returns both `id` and `url`, so the model reasonably passes
 * either — and it passed the URL on dev, producing an error naming a path.
 * Query strings and fragments come from ids copied out of rendered markdown.
 */
export function normalizeFileRef(raw: string): string {
  const trimmed = raw.trim();
  const withoutQuery = trimmed.split(/[?#]/)[0]!;
  const lastSegment = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  return lastSegment;
}

/**
 * Resolve refs against one conversation, or report which ones do not belong.
 *
 * Unresolvable refs are reported rather than skipped: silently dropping one
 * would send an email whose body promises an attachment it does not carry.
 */
export async function resolveConversationFiles(
  db: DatabaseProvider,
  sessionId: string,
  refs: string[],
): Promise<ResolveResult> {
  if (refs.length === 0) return { ok: true, files: [] };

  const normalized = refs.map((ref) => ({ ref, id: normalizeFileRef(ref) }));
  const rows = await db.chatFiles.listBySessionAndIds(
    sessionId,
    normalized.map((n) => n.id),
  );

  const files: ConversationFile[] = [];
  const missing: string[] = [];

  for (const { ref, id } of normalized) {
    const row = rows.find((r) => r.id === id);
    if (row) {
      files.push({
        ref,
        name: row.name,
        content_type: row.content_type,
        size: row.size,
        read: async () => (await getObjectAtKey(row.storage_key))?.buffer ?? null,
      });
      continue;
    }

    // Not a chat file — it may still be an image this conversation produced or
    // received. `isValidUploadId` first so a malformed ref never reaches a query.
    if (isValidUploadId(id) && (await db.sessions.sessionReferencesImage(sessionId, id))) {
      const object = await getUpload(id);
      if (object) {
        files.push({
          ref,
          name: id,
          content_type: object.contentType,
          size: object.buffer.length,
          // Already in hand; re-reading object storage would only cost a round trip.
          read: async () => object.buffer,
        });
        continue;
      }
    }
    missing.push(ref);
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true, files };
}
