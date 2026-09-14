/**
 * Drive routes — /api/drive
 *
 * A generic folder/file cabinet over db.drive, shared by committed scopes:
 *   - scope='kb'  → knowledge-base folders (visibility + owner_user_id).
 *   - scope='tables' → Tables Base files (base_id + Base ACL).
 *   - an extension scope → keyed by `owner_key`, authorized by the resolver the
 *     extension registered. Core validates the shape and delegates the rule.
 *
 * Auth: mounted behind requireInternal(); per-node authorization is resolveDriveAccess
 * (the single source of truth, also unit-tested). Downloads are NEVER public — the
 * route checks access, then either 302s to a short-lived presigned COS URL or streams
 * the bytes itself (local dev). Uploads go direct to COS via a presigned PUT when COS
 * is configured, else proxy through the API onto local disk.
 *
 * Folders:
 *   GET    /folders?scope&base_id|visibility&parent_id      — list one level
 *   POST   /folders                                         — create
 *   PUT    /folders/:id                                     — rename and/or move
 *   DELETE /folders/:id                                     — delete (must be empty)
 *   GET    /breadcrumb?folder_id                            — ancestor chain
 * Files:
 *   GET    /files?scope&base_id|visibility&folder_id        — list active files
 *   POST   /files/init                                      — start an upload (presign or proxy)
 *   POST   /files/:id/complete                              — confirm a presigned upload
 *   PUT    /files/:id/content                               — proxy upload (local/fallback)
 *   GET    /files/:id/content                               — forced attachment download (302 or stream)
 *   DELETE /files/:id                                       — soft-delete + GC the object
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { DriveScope, DriveFolderRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getAuthUser } from '../auth/middleware.js';
import { contentDisposition } from '../http/content-disposition.js';
import { resolveDriveAccessAsync, isKnownDriveScope, canReadDrive, canWriteDrive } from '../drive/access.js';
import type { DriveAccessNode } from '../drive/access.js';
import { validateDriveUpload, safeDriveContentType, MAX_DRIVE_FILE_SIZE } from '../drive/upload-policy.js';
import {
  driveKeyFor,
  presignPutUrl,
  presignGetUrl,
  headObjectSize,
  putObjectAtKey,
  getObjectAtKey,
  deleteObjectAtKey,
} from '../storage/uploads.js';
import type { AppEnv } from '../app-env.js';
import { humanActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';

// ─── Helpers ─────────────────────────────────────────────

interface ScopeKeys {
  scope: DriveScope;
  visibility: 'team' | 'private' | null;
  owner_user_id: string | null;
  base_id: number | null;
  owner_key: string | null;
}

/** Core owns exactly these two; everything else must come from an extension. */
function isCoreScope(scope: string): scope is 'kb' | 'tables' {
  return scope === 'kb' || scope === 'tables';
}

/**
 * Resolve the scope's owner keys from caller input, deriving (never trusting) the
 * owner for private KB nodes. Returns an error string for an incomplete scope.
 */
function buildScopeKeys(
  c: Context<AppEnv>,
  scope: DriveScope,
  input: { base_id?: number | null; visibility?: 'team' | 'private'; owner_key?: string | null },
): ScopeKeys | { error: string } {
  if (!isCoreScope(scope)) {
    if (!input.owner_key) return { error: `owner_key is required for the ${scope} scope` };
    return { scope, base_id: null, visibility: null, owner_user_id: null, owner_key: input.owner_key };
  }
  if (scope === 'tables') {
    if (!input.base_id) return { error: 'base_id is required for tables scope' };
    return { scope, base_id: input.base_id, visibility: null, owner_user_id: null, owner_key: null };
  }
  const visibility = input.visibility ?? 'team';
  const user = getAuthUser(c);
  return {
    scope,
    base_id: null,
    visibility,
    owner_user_id: visibility === 'private' ? user.id : null,
    owner_key: null,
  };
}

/** Authorize against a node (folder/file row, or a scope-root descriptor). */
async function accessFor(c: Context<AppEnv>, node: DriveAccessNode, operation: 'read' | 'write') {
  const user = getAuthUser(c);
  let tablesRole: 'owner' | 'builder' | 'editor' | 'viewer' | null | undefined;
  if (node.scope === 'tables' && node.base_id) {
    const decision = await getPlatformRuntime().authorize(
      humanActor(user, c),
      operation === 'read' ? 'tables.data.read' : 'tables.data.update',
    );
    if (!decision.allowed) return null;
    const db = getDb();
    const [base, member] = await Promise.all([
      db.tables.getBase(node.base_id),
      db.tables.getBaseMember(node.base_id, user.id),
    ]);
    if (base && !base.archived_at) {
      if (user.role === 'super' || base.owner_id === user.id) tablesRole = 'owner';
      else if (member) tablesRole = member.role;
      else if (base.visibility === 'team') tablesRole = 'viewer';
      else tablesRole = null;
    }
  }
  return resolveDriveAccessAsync(node, { userId: user.id, userRole: user.role, db: getDb(), operation, tablesRole });
}

const toNode = (
  row: Pick<DriveFolderRow, 'scope' | 'visibility' | 'owner_user_id' | 'base_id' | 'owner_key'>,
): DriveAccessNode => ({
  scope: row.scope,
  visibility: row.visibility,
  owner_user_id: row.owner_user_id,
  base_id: row.base_id,
  owner_key: row.owner_key,
});

function parseScopeParam(v?: string): DriveScope | null {
  return v && isKnownDriveScope(v) ? v : null;
}

function parseIntOrNull(v?: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Any registered scope — `isKnownDriveScope` is the gate, not a fixed enum. */
const scopeEnum = z.string().refine(isKnownDriveScope, { message: 'unknown scope' });
const visibilityEnum = z.enum(['team', 'private']);

const folderCreateSchema = z.object({
  scope: scopeEnum,
  base_id: z.number().int().positive().optional(),
  owner_key: z.string().min(1).max(128).optional(),
  visibility: visibilityEnum.optional(),
  parent_id: z.number().int().positive().optional(),
  name: z
    .string()
    .min(1)
    .transform((s) => s.trim()),
});

// `parent_id: null` moves the folder to the root; omitting a key leaves it as is.
const folderUpdateSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, 'name is required')
      .optional(),
    parent_id: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.parent_id !== undefined, 'nothing to update');

const fileInitSchema = z.object({
  scope: scopeEnum,
  base_id: z.number().int().positive().optional(),
  owner_key: z.string().min(1).max(128).optional(),
  visibility: visibilityEnum.optional(),
  folder_id: z.number().int().positive().optional(),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  content_type: z.string().optional(),
});

// ─── Routes ──────────────────────────────────────────────

const drive = new Hono<AppEnv>()
  // ── Folders ──
  .get('/folders', async (c) => {
    const scope = parseScopeParam(c.req.query('scope'));
    if (!scope) return c.json({ error: 'invalid scope' }, 400);
    const visRaw = c.req.query('visibility');
    const keys = buildScopeKeys(c, scope, {
      base_id: parseIntOrNull(c.req.query('base_id')),
      owner_key: c.req.query('owner_key') ?? null,
      visibility: visRaw === 'team' || visRaw === 'private' ? visRaw : undefined,
    });
    if ('error' in keys) return c.json({ error: keys.error }, 400);
    if (!canReadDrive(await accessFor(c, keys, 'read'))) return c.json({ error: 'forbidden' }, 403);

    // `parent_id=all` returns every folder in the scope (flat) so a client can
    // build the whole tree in one request; omitting it keeps the historical
    // "root level only" behaviour.
    const parentParam = c.req.query('parent_id');
    const folders = await getDb().drive.listFolders({
      scope,
      base_id: keys.base_id ?? undefined,
      owner_key: keys.owner_key ?? undefined,
      visibility: keys.visibility ?? undefined,
      owner_user_id: keys.owner_user_id ?? undefined,
      parent_id: parentParam === 'all' ? undefined : parseIntOrNull(parentParam),
    });
    return c.json({ folders });
  })
  .post('/folders', async (c) => {
    const parsed = folderCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid input' }, 400);
    const { scope, base_id, visibility, owner_key, parent_id, name } = parsed.data;
    const keys = buildScopeKeys(c, scope, { base_id, visibility, owner_key });
    if ('error' in keys) return c.json({ error: keys.error }, 400);
    if (!canWriteDrive(await accessFor(c, keys, 'write'))) return c.json({ error: 'forbidden' }, 403);

    const db = getDb();
    if (parent_id) {
      const parent = await db.drive.getFolder(parent_id);
      if (
        !parent ||
        parent.scope !== scope ||
        parent.base_id !== keys.base_id ||
        parent.owner_key !== keys.owner_key ||
        parent.visibility !== keys.visibility ||
        parent.owner_user_id !== keys.owner_user_id
      ) {
        return c.json({ error: 'parent folder not found' }, 404);
      }
    }
    const folder = await db.drive.createFolder({
      scope,
      parent_id: parent_id ?? null,
      name,
      base_id: keys.base_id,
      owner_key: keys.owner_key,
      visibility: keys.visibility,
      owner_user_id: keys.owner_user_id,
      created_by: getAuthUser(c).id,
    });
    return c.json({ folder });
  })
  .put('/folders/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = folderUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid input' }, 400);

    const db = getDb();
    const folder = await db.drive.getFolder(id);
    if (!folder) return c.json({ error: 'not found' }, 404);
    if (!canWriteDrive(await accessFor(c, toNode(folder), 'write'))) return c.json({ error: 'forbidden' }, 403);

    // A move must be authorized on BOTH ends, and may never cross a scope or an
    // ownership domain (kb team ↔ private, or another Base's cabinet):
    // otherwise a writable source folder would be a lift into a foreign tree.
    const { name, parent_id } = parsed.data;
    if (parent_id != null) {
      const parent = await db.drive.getFolder(parent_id);
      if (!parent) return c.json({ error: 'parent folder not found' }, 404);
      if (
        parent.scope !== folder.scope ||
        parent.visibility !== folder.visibility ||
        parent.owner_user_id !== folder.owner_user_id ||
        parent.base_id !== folder.base_id ||
        parent.owner_key !== folder.owner_key
      ) {
        return c.json({ error: 'parent folder is in a different scope' }, 400);
      }
      if (!canWriteDrive(await accessFor(c, toNode(parent), 'write'))) return c.json({ error: 'forbidden' }, 403);
    }

    const result = await db.drive.updateFolder(id, { name, parent_id });
    if (!result.ok) {
      return result.reason === 'cycle'
        ? c.json({ error: 'cannot move a folder into itself or its own subfolder' }, 400)
        : c.json({ error: 'not found' }, 404);
    }
    return c.json({ folder: result.folder });
  })
  .delete('/folders/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const db = getDb();
    const folder = await db.drive.getFolder(id);
    if (!folder) return c.json({ error: 'not found' }, 404);
    if (!canWriteDrive(await accessFor(c, toNode(folder), 'write'))) return c.json({ error: 'forbidden' }, 403);
    const result = await db.drive.deleteFolder(id);
    if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_empty' ? 409 : 404);
    return c.json({ ok: true });
  })
  .get('/breadcrumb', async (c) => {
    const folderId = parseIntOrNull(c.req.query('folder_id'));
    if (folderId == null) return c.json({ folders: [] });
    const db = getDb();
    const folder = await db.drive.getFolder(folderId);
    if (!folder) return c.json({ error: 'not found' }, 404);
    if (!canReadDrive(await accessFor(c, toNode(folder), 'read'))) return c.json({ error: 'forbidden' }, 403);
    return c.json({ folders: await db.drive.breadcrumb(folderId) });
  })
  // ── Files ──
  .get('/files', async (c) => {
    const scope = parseScopeParam(c.req.query('scope'));
    if (!scope) return c.json({ error: 'invalid scope' }, 400);
    const visRaw = c.req.query('visibility');
    const keys = buildScopeKeys(c, scope, {
      base_id: parseIntOrNull(c.req.query('base_id')),
      owner_key: c.req.query('owner_key') ?? null,
      visibility: visRaw === 'team' || visRaw === 'private' ? visRaw : undefined,
    });
    if ('error' in keys) return c.json({ error: keys.error }, 400);
    if (!canReadDrive(await accessFor(c, keys, 'read'))) return c.json({ error: 'forbidden' }, 403);

    const files = await getDb().drive.listFiles({
      scope,
      base_id: keys.base_id ?? undefined,
      owner_key: keys.owner_key ?? undefined,
      visibility: keys.visibility ?? undefined,
      owner_user_id: keys.owner_user_id ?? undefined,
      folder_id: parseIntOrNull(c.req.query('folder_id')),
    });
    return c.json({ files });
  })
  .post('/files/init', async (c) => {
    const parsed = fileInitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid input' }, 400);
    const { scope, base_id, visibility, owner_key, folder_id, name, size, content_type } = parsed.data;

    const valid = validateDriveUpload({ name, size, content_type });
    if (!valid.ok) return c.json({ error: valid.error }, 400);

    const keys = buildScopeKeys(c, scope, { base_id, visibility, owner_key });
    if ('error' in keys) return c.json({ error: keys.error }, 400);
    if (!canWriteDrive(await accessFor(c, keys, 'write'))) return c.json({ error: 'forbidden' }, 403);

    const cosKey = driveKeyFor({
      scope,
      baseId: keys.base_id,
      ownerKey: keys.owner_key,
      visibility: keys.visibility,
      filename: name,
    });
    const file = await getDb().drive.initFile({
      scope,
      folder_id: folder_id ?? null,
      name,
      cos_key: cosKey,
      // Client MIME is only an input to the reject policy. Stored response
      // metadata is derived from the already-validated filename.
      content_type: safeDriveContentType(name),
      size,
      base_id: keys.base_id,
      owner_key: keys.owner_key,
      visibility: keys.visibility,
      owner_user_id: keys.owner_user_id,
      uploaded_by: getAuthUser(c).id,
    });

    const uploadUrl = await presignPutUrl(cosKey);
    if (uploadUrl) {
      return c.json({
        file_id: file.id,
        mode: 'cos',
        upload_url: uploadUrl,
        complete_url: `/api/drive/files/${file.id}/complete`,
      });
    }
    // No COS → proxy the bytes through the API onto local disk.
    return c.json({ file_id: file.id, mode: 'proxy', upload_url: `/api/drive/files/${file.id}/content` });
  })
  .post('/files/:id/complete', async (c) => {
    const id = Number(c.req.param('id'));
    const db = getDb();
    const file = await db.drive.getFile(id);
    if (!file) return c.json({ error: 'not found' }, 404);
    if (!canWriteDrive(await accessFor(c, toNode(file), 'write'))) return c.json({ error: 'forbidden' }, 403);

    // Trust the bucket, not the client: the real size comes from HeadObject.
    const size = await headObjectSize(file.cos_key);
    if (size == null) return c.json({ error: 'object not uploaded' }, 400);
    if (size > MAX_DRIVE_FILE_SIZE) {
      await deleteObjectAtKey(file.cos_key).catch(() => {});
      await db.drive.softDeleteFile(id);
      return c.json({ error: 'file too large' }, 400);
    }
    const completed = await db.drive.completeFile(id, { size });
    return c.json({ file: completed ?? file });
  })
  .put(
    '/files/:id/content',
    bodyLimit({
      maxSize: MAX_DRIVE_FILE_SIZE,
      onError: (c) => c.json({ error: 'file too large' }, 413),
    }),
    async (c) => {
      const id = Number(c.req.param('id'));
      const db = getDb();
      const file = await db.drive.getFile(id);
      if (!file) return c.json({ error: 'not found' }, 404);
      if (!canWriteDrive(await accessFor(c, toNode(file), 'write'))) return c.json({ error: 'forbidden' }, 403);

      const buffer = Buffer.from(await c.req.arrayBuffer());
      await putObjectAtKey(file.cos_key, buffer, safeDriveContentType(file.name));
      const completed = await db.drive.completeFile(id, { size: buffer.length });
      return c.json({ file: completed ?? file });
    },
  )
  .get('/files/:id/content', async (c) => {
    const id = Number(c.req.param('id'));
    const file = await getDb().drive.getFile(id);
    if (!file || file.status !== 'active') return c.json({ error: 'not found' }, 404);
    if (!canReadDrive(await accessFor(c, toNode(file), 'read'))) return c.json({ error: 'forbidden' }, 403);

    // Never cache authed customer bytes — and never the signed-URL redirect either:
    // a shared browser could otherwise replay one user's download (or the still-valid
    // presigned URL) to the next within the TTL, bypassing the per-request auth check.
    c.header('Cache-Control', 'no-store');

    const contentType = safeDriveContentType(file.name);
    const signed = await presignGetUrl(file.cos_key, 120, { filename: file.name, contentType });
    if (signed) return c.redirect(signed, 302);

    // Local: stream the bytes ourselves (still behind auth).
    const obj = await getObjectAtKey(file.cos_key);
    if (!obj) return c.json({ error: 'not found' }, 404);
    c.header('Content-Type', contentType);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', contentDisposition(file.name));
    return c.body(Uint8Array.from(obj.buffer).buffer);
  })
  .delete('/files/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const db = getDb();
    const file = await db.drive.getFile(id);
    if (!file) return c.json({ error: 'not found' }, 404);
    if (!canWriteDrive(await accessFor(c, toNode(file), 'write'))) return c.json({ error: 'forbidden' }, 403);

    await db.drive.softDeleteFile(id);
    // Best-effort object GC; the row already dropped from listings.
    deleteObjectAtKey(file.cos_key).catch((err) =>
      logger.warn(`[Drive] object GC failed for ${file.cos_key}: ${toErrorMessage(err)}`),
    );
    return c.json({ ok: true });
  });

export default drive;
