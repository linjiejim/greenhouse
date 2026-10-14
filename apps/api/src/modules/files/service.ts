/**
 * The one file service. Bytes only ever go through the storage provider; the object key is
 * generated here and never taken from input. A file remembers the storage instance that holds
 * it, so changing the storage order later does not lose it. Who may read a file follows what
 * it belongs to: its owner, the people of its conversation, the owner of its run, whoever sees
 * the skill a package belongs to, whoever reads the base of a record's attachment; a member's
 * current avatar is visible to every member, and the workspace logo to everyone.
 *
 * Bytes are read through signed URLs, so an `<img>` or a link works without a bearer header. A
 * URL is made for one member (`m`) and ends within one to two hours; serving it checks the
 * signature, that the member is still active, and that they may still read the file. The logo's
 * URL names no member: it is the only file that needs no sign-in.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FileView } from '@greenhouse/contract';
import {
  conversationMembers,
  files,
  getDb,
  members,
  newId,
  runs,
  workspace,
  type FilePurpose,
  type FileRow,
} from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import type { ProvidersService } from '../../providers/service.js';
import { bundleHeld, bundleReadable } from '../skills/access.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Shown in the browser; everything else downloads, so a page or SVG never runs on our origin. */
const INLINE_TYPES = new Set([...IMAGE_TYPES, 'application/pdf', 'text/plain', 'audio/mpeg', 'audio/wav', 'video/mp4']);
/** Purposes everyone may see once in use (an avatar, the logo): the bytes must really be an image. */
const PICTURE_PURPOSES: readonly FilePurpose[] = ['avatar', 'branding'];
/** File URLs live in one-hour windows: stable within the hour (browsers cache them), valid one to two hours. */
export const FILE_URL_WINDOW_S = 60 * 60;

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

/** The image type the bytes really are (PNG, JPEG, GIF, WebP), whatever the upload claimed. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (offset: number, signature: number[]) => signature.every((byte, index) => bytes[offset + index] === byte);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

export interface SignedFileUrl {
  url: string;
  expiresAt: string;
}

export function createFilesService(deps: {
  providers: ProvidersService;
  /** Keyed hash for file URLs (tokens.hashSecret with purpose `file`). */
  sign: (data: string) => string;
}) {
  async function storageFor(memberId: string) {
    const storage = await deps.providers.resolve('storage', { memberId });
    if (!storage) throw new ApiError(503, 'storage_not_configured', 'File storage is not set up.');
    return storage;
  }

  const macOf = (id: string, memberId: string | null, exp: number) => deps.sign(`file:${id}:${memberId ?? ''}:${exp}`);

  /** A URL for one member (or, with null, for anyone: only the logo serves that way). */
  function signedUrl(id: string, memberId: string | null, now = Date.now()): SignedFileUrl {
    const exp = (Math.floor(now / 1000 / FILE_URL_WINDOW_S) + 2) * FILE_URL_WINDOW_S;
    const query = new URLSearchParams({ exp: String(exp) });
    if (memberId) query.set('m', memberId);
    query.set('sig', macOf(id, memberId, exp));
    return { url: `/api/files/${id}/content?${query.toString()}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  function validSignature(id: string, memberId: string | null, exp: number, sig: string): boolean {
    if (exp * 1000 <= Date.now()) return false;
    const expected = Buffer.from(macOf(id, memberId, exp));
    const actual = Buffer.from(sig);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  const toFile = (row: FileRow, memberId: string): FileView => {
    const link = signedUrl(row.id, memberId);
    return {
      id: row.id,
      name: row.name,
      content_type: row.contentType,
      size_bytes: row.sizeBytes,
      purpose: row.purpose,
      owner_id: row.ownerId,
      conversation_id: row.conversationId,
      run_id: row.runId,
      url: link.url,
      expires_at: link.expiresAt,
      created_at: row.createdAt,
    };
  };

  async function isAvatar(id: string): Promise<boolean> {
    const [row] = await getDb().select({ id: members.id }).from(members).where(eq(members.avatarFileId, id)).limit(1);
    return !!row;
  }

  async function isLogo(id: string): Promise<boolean> {
    const [row] = await getDb()
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.logoFileId, id))
      .limit(1);
    return !!row;
  }

  /** Purposes whose files another module guards (knowledge files follow their folder or doc). */
  const governed = new Map<FilePurpose, (memberId: string, row: FileRow) => Promise<boolean>>();

  async function canRead(memberId: string, row: FileRow): Promise<boolean> {
    if (row.status !== 'active') return false;
    const guard = governed.get(row.purpose);
    if (guard) return guard(memberId, row);
    if (row.ownerId === memberId) return true;
    // Anyone may see a picture once it is someone's avatar or the logo; nothing else of its owner's.
    if (row.purpose === 'avatar') return IMAGE_TYPES.includes(row.contentType) && (await isAvatar(row.id));
    if (row.purpose === 'branding') return IMAGE_TYPES.includes(row.contentType) && (await isLogo(row.id));
    // A package's ZIP is for whoever sees the skill version that holds it.
    if (row.purpose === 'skill') return bundleReadable(memberId, row.id);
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

  /** Marks the file deleted and removes its bytes. */
  async function discard(row: FileRow, memberId?: string): Promise<void> {
    await getDb()
      .update(files)
      .set({ status: 'deleted', updatedAt: sql`now()` })
      .where(eq(files.id, row.id));
    const storage = await deps.providers.byId('storage', row.providerId, memberId ? { memberId } : {});
    await storage?.client
      .delete(row.storageKey)
      .catch((error: unknown) =>
        logger.warn('[files] could not delete stored bytes', { file: row.id, error: toErrorMessage(error) }),
      );
  }

  const service = {
    signedUrl,

    /** Hands the read check for one purpose to the module that owns those files. */
    govern(purpose: FilePurpose, guard: (memberId: string, row: FileRow) => Promise<boolean>): void {
      governed.set(purpose, guard);
    },

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
        /** Record attachments: the base they belong to. */
        baseId?: string | null;
        /** Knowledge files: where in the tree, and whose space (null: the team's). */
        folderId?: string | null;
        space?: 'team' | 'personal';
        ownerId?: string | null;
        meta?: Record<string, unknown>;
      },
    ): Promise<FileView> {
      if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw invalidInput('Files can be up to 50 MB.');
      let contentType = /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType)
        ? input.contentType.toLowerCase()
        : 'application/octet-stream';
      if (PICTURE_PURPOSES.includes(input.purpose)) {
        // Everyone sees these: the type comes from the bytes, never from what the upload said.
        const sniffed = sniffImage(input.bytes);
        if (!sniffed) throw invalidInput('Use a PNG, JPEG, GIF or WebP image.');
        if (input.bytes.byteLength > MAX_AVATAR_BYTES) throw invalidInput('Images can be up to 5 MB.');
        contentType = sniffed;
      }
      const storage = await storageFor(memberId);
      const id = newId('file');
      const now = new Date();
      const key = `${input.purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
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
          ownerId: input.ownerId === undefined ? memberId : input.ownerId,
          conversationId: input.conversationId ?? null,
          runId: input.runId ?? null,
          baseId: input.baseId ?? null,
          folderId: input.folderId ?? null,
          space: input.space ?? null,
          meta: input.meta ?? {},
        })
        .returning();
      return toFile(row!, memberId);
    },

    async get(memberId: string, id: string): Promise<FileRow> {
      const [row] = await getDb().select().from(files).where(eq(files.id, id));
      if (!row || !(await canRead(memberId, row))) throw notFound('File');
      return row;
    },

    /** What it is, with a fresh URL for this member. */
    async view(memberId: string, id: string): Promise<FileView> {
      return toFile(await service.get(memberId, id), memberId);
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

    /**
     * The bytes behind a signed URL. Anything wrong (signature, expiry, a member no longer active
     * or no longer allowed, a file that is gone) answers not found. `maxAge` is what is left of it.
     */
    async signedContent(id: string, query: { exp: number; m?: string | undefined; sig: string }) {
      const memberId = query.m ?? null;
      if (!validSignature(id, memberId, query.exp, query.sig)) throw notFound('File');
      const [row] = await getDb().select().from(files).where(eq(files.id, id));
      if (!row || row.status !== 'active') throw notFound('File');
      if (memberId) {
        const [member] = await getDb().select({ status: members.status }).from(members).where(eq(members.id, memberId));
        if (member?.status !== 'active' || !(await canRead(memberId, row))) throw notFound('File');
      } else if (row.purpose !== 'branding' || !IMAGE_TYPES.includes(row.contentType) || !(await isLogo(row.id))) {
        throw notFound('File');
      }
      const storage = await deps.providers.byId('storage', row.providerId, memberId ? { memberId } : {});
      if (!storage)
        throw new ApiError(503, 'storage_unavailable', 'The storage that holds this file is not available.');
      const object = await storage.client.get(row.storageKey);
      if (!object) throw notFound('File');
      return { row, body: object.body, maxAge: Math.max(0, query.exp - Math.floor(Date.now() / 1000)) };
    },

    /** The whole file in memory, for tools that read it (bounded by MAX_UPLOAD_BYTES). */
    async bytes(memberId: string, id: string): Promise<{ row: FileRow; bytes: Uint8Array }> {
      const { row, body } = await service.content(memberId, id);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      return { row, bytes };
    },

    /**
     * Keeps what reading a file learned (an audio file's transcript) with it, so the next read is
     * free. The bytes never change, so neither does what was learned from them.
     */
    async remember(id: string, learned: Record<string, unknown>): Promise<void> {
      await getDb()
        .update(files)
        .set({ meta: sql`${files.meta} || ${JSON.stringify(learned)}::jsonb` })
        .where(eq(files.id, id));
    },

    /**
     * A picture the member uploaded for this purpose, to become their avatar or the logo. Someone
     * else's file is not found.
     */
    async ownPicture(memberId: string, id: string, purpose: 'avatar' | 'branding'): Promise<FileRow> {
      const [row] = await getDb().select().from(files).where(eq(files.id, id));
      if (!row || row.status !== 'active' || row.ownerId !== memberId) throw notFound('File');
      if (row.purpose !== purpose || !IMAGE_TYPES.includes(row.contentType)) {
        throw invalidInput(`Upload the image with purpose "${purpose}" first.`);
      }
      return row;
    },

    /** Deletes a file nothing uses any more (a replaced avatar or logo), whoever uploaded it. */
    async discard(id: string): Promise<void> {
      const [row] = await getDb().select().from(files).where(eq(files.id, id));
      if (row && row.status === 'active') await discard(row);
    },

    /**
     * Deleting is the owner's: the row is marked and the bytes removed; an avatar or logo it was
     * goes too. A skill version's package stays: versions are immutable.
     */
    async remove(memberId: string, id: string): Promise<void> {
      const [row] = await getDb().select().from(files).where(eq(files.id, id));
      if (!row || row.status !== 'active' || row.ownerId !== memberId) throw notFound('File');
      if (governed.has(row.purpose)) throw conflict('file_governed', 'Archive this file where it lives instead.');
      if (row.purpose === 'skill' && (await bundleHeld(row.id))) {
        throw conflict('file_in_use', 'This file is a version of a skill; archive the skill instead.');
      }
      await getDb()
        .update(members)
        .set({ avatarFileId: null, updatedAt: sql`now()` })
        .where(eq(members.avatarFileId, id));
      await getDb()
        .update(workspace)
        .set({ logoFileId: null, updatedAt: sql`now()` })
        .where(eq(workspace.logoFileId, id));
      await discard(row, memberId);
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
