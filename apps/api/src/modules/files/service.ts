/**
 * The one file service. Bytes only ever go through the storage provider; the object key is
 * generated here and never taken from input. A file remembers the storage instance that holds
 * it, so changing the storage order later does not lose it. Who may read a file follows what
 * it belongs to: its owner, the people of its conversation, the owner of its run; avatars and
 * branding are visible to every member.
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FileView } from '@greenhouse/contract';
import { conversationMembers, files, getDb, newId, runs, type FilePurpose, type FileRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import type { ProvidersService } from '../../providers/service.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Shown in the browser; everything else downloads, so a page or SVG never runs on our origin. */
const INLINE_TYPES = new Set([...IMAGE_TYPES, 'application/pdf', 'text/plain', 'audio/mpeg', 'audio/wav', 'video/mp4']);

export const toFile = (row: FileRow): FileView => ({
  id: row.id,
  name: row.name,
  content_type: row.contentType,
  size_bytes: row.sizeBytes,
  purpose: row.purpose,
  owner_id: row.ownerId,
  conversation_id: row.conversationId,
  run_id: row.runId,
  url: `/api/files/${row.id}/content`,
  created_at: row.createdAt,
});

/** A display name that is safe in a header and a path: no directories, no control characters. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = [...base]
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}

export function dispositionFor(row: Pick<FileRow, 'name' | 'contentType'>): { type: string; disposition: string } {
  const inline = INLINE_TYPES.has(row.contentType);
  const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    type: inline ? row.contentType : 'application/octet-stream',
    disposition: `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
  };
}

export function createFilesService(deps: { providers: ProvidersService }) {
  async function storageFor(memberId: string) {
    const storage = await deps.providers.resolve('storage', { memberId });
    if (!storage) throw new ApiError(503, 'storage_not_configured', 'File storage is not set up.');
    return storage;
  }

  async function canRead(memberId: string, row: FileRow): Promise<boolean> {
    if (row.status !== 'active') return false;
    if (row.ownerId === memberId) return true;
    if (row.purpose === 'avatar' || row.purpose === 'branding') return true;
    if (row.conversationId) {
      const [seat] = await getDb()
        .select({ id: conversationMembers.memberId })
        .from(conversationMembers)
        .where(
          and(eq(conversationMembers.conversationId, row.conversationId), eq(conversationMembers.memberId, memberId)),
        );
      if (seat) return true;
    }
    if (row.runId) {
      const [run] = await getDb().select({ ownerId: runs.ownerId }).from(runs).where(eq(runs.id, row.runId));
      if (run?.ownerId === memberId) return true;
    }
    return false;
  }

  const service = {
    /** Stores bytes for a member. The server writes run artifacts and exports through the same path. */
    async store(
      memberId: string,
      input: {
        name: string;
        contentType: string;
        bytes: Uint8Array;
        purpose: FilePurpose;
        conversationId?: string | null;
        runId?: string | null;
      },
    ): Promise<FileView> {
      if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw invalidInput('Files can be up to 50 MB.');
      if ((input.purpose === 'avatar' || input.purpose === 'branding') && !IMAGE_TYPES.includes(input.contentType)) {
        throw invalidInput('Use a PNG, JPEG, GIF or WebP image.');
      }
      if (input.purpose === 'avatar' && input.bytes.byteLength > MAX_AVATAR_BYTES)
        throw invalidInput('Images can be up to 5 MB.');
      const storage = await storageFor(memberId);
      const id = newId('file');
      const now = new Date();
      const key = `${input.purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
      const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType)
        ? input.contentType.toLowerCase()
        : 'application/octet-stream';
      await storage.client.put(key, input.bytes, { contentType });
      const [row] = await getDb()
        .insert(files)
        .values({
          id,
          purpose: input.purpose,
          providerId: storage.instance.id,
          storageKey: key,
          name: cleanName(input.name),
          contentType,
          sizeBytes: input.bytes.byteLength,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
          status: 'active',
          ownerId: memberId,
          conversationId: input.conversationId ?? null,
          runId: input.runId ?? null,
        })
        .returning();
      return toFile(row!);
    },

    async get(memberId: string, id: string): Promise<FileRow> {
      const [row] = await getDb().select().from(files).where(eq(files.id, id));
      if (!row || !(await canRead(memberId, row))) throw notFound('File');
      return row;
    },

    async view(memberId: string, id: string): Promise<FileView> {
      return toFile(await service.get(memberId, id));
    },

    /** The bytes, from the instance that holds them. */
    async content(memberId: string, id: string) {
      const row = await service.get(memberId, id);
      const storage = await deps.providers.byId('storage', row.providerId, { memberId });
      if (!storage)
        throw new ApiError(503, 'storage_unavailable', 'The storage that holds this file is not available.');
      const object = await storage.client.get(row.storageKey);
      if (!object) throw notFound('File');
      return { row, body: object.body };
    },

    /** The whole file in memory, for tools that read it (bounded by MAX_UPLOAD_BYTES). */
    async bytes(memberId: string, id: string): Promise<{ row: FileRow; bytes: Uint8Array }> {
      const { row, body } = await service.content(memberId, id);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      return { row, bytes };
    },

    /** Deleting is the owner's: the row is marked and the bytes removed. */
    async remove(memberId: string, id: string): Promise<void> {
      const [row] = await getDb().select().from(files).where(eq(files.id, id));
      if (!row || row.status !== 'active' || row.ownerId !== memberId) throw notFound('File');
      await getDb()
        .update(files)
        .set({ status: 'deleted', updatedAt: sql`now()` })
        .where(eq(files.id, id));
      const storage = await deps.providers.byId('storage', row.providerId, { memberId });
      await storage?.client
        .delete(row.storageKey)
        .catch((error: unknown) =>
          logger.warn('[files] could not delete stored bytes', { file: id, error: toErrorMessage(error) }),
        );
    },

    /**
     * Attachments sent into a conversation belong to it from then on, so everyone there can
     * open them. Only the sender's own, still unattached files can be attached.
     */
    async attach(memberId: string, conversationId: string, ids: string[]): Promise<void> {
      if (!ids.length) return;
      const rows = await getDb()
        .select()
        .from(files)
        .where(and(inArray(files.id, ids), eq(files.status, 'active')));
      const usable = rows.filter(
        (row) => row.conversationId === conversationId || (row.ownerId === memberId && !row.conversationId),
      );
      if (usable.length !== new Set(ids).size) throw invalidInput('Some attachments cannot be used here.');
      if (rows.some((row) => row.purpose !== 'attachment'))
        throw conflict('not_an_attachment', 'Only uploaded attachments can be sent.');
      await getDb()
        .update(files)
        .set({ conversationId, updatedAt: sql`now()` })
        .where(and(inArray(files.id, ids), isNull(files.conversationId)));
    },
  };
  return service;
}

export type FilesService = ReturnType<typeof createFilesService>;
