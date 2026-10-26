import { humanActor } from '../platform/actor.js';
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
 *   GET    /search?q&limit                                  — name search over the knowledge cabinet
 *                                                             (team + my personal nodes)
 * Files:
 *   GET    /files?scope&base_id|visibility&folder_id        — list active files
 *   POST   /files/init                                      — start an upload (presign or proxy)
 *   POST   /files/:id/complete                              — confirm a presigned upload
 *   PUT    /files/:id/content                               — proxy upload (local/fallback)
 *   GET    /files/:id/content                               — forced attachment download (302 or stream)
 *   PUT    /files/:id                                       — rename and/or move
 *   DELETE /files/:id                                       — soft-delete + GC the object
 *
 * Every successful write is also recorded in the platform audit (drive/audit.ts)
 * so the Activity log can show who changed which file.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { DriveScope, DriveFolderRow } from '@greenhouse/db';
import { toRowId } from '@greenhouse/utils/id';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getAuthUser } from '../auth/middleware.js';
import { contentDisposition } from '../http/content-disposition.js';
import {
  resolveDriveAccessAsync,
  extensionDrivePlacement,
  isKnownDriveScope,
  cabinetDriveScope,
  canReadDrive,
  canWriteDrive,
  sameDriveCabinet,
} from '../drive/access.js';
import { recordDriveChange } from '../drive/audit.js';
import { searchCabinet } from '../drive/kb-cabinet.js';
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

// ─── Helpers ─────────────────────────────────────────────

interface ScopeKeys {
  scope: DriveScope;
  visibility: 'team' | 'private' | null;
  owner_user_id: string | null;
  base_id: string | null;
  owner_key: string | null;
}

/**
 * Resolve the scope's owner keys from caller input, deriving (never trusting) the
 * owner for private KB nodes. Returns an error string for an incomplete scope.
 */
function buildScopeKeys(
  c: Context<AppEnv>,
  scope: DriveScope,
  input: { base_id?: string | null; visibility?: 'team' | 'private'; owner_key?: string | null },
): ScopeKeys | { error: string } {
  const placement = extensionDrivePlacement(scope, input, getAuthUser(c).id);
  return 'error' in placement ? placement : { scope, ...placement };
}

/** Authorize against a node (folder/file row, or a scope-root descriptor). */
async function accessFor(c: Context<AppEnv>, node: DriveAccessNode, operation: 'read' | 'write') {
  const user = getAuthUser(c);
  return resolveDriveAccessAsync(node, { userId: user.id, userRole: user.role, db: getDb(), operation });
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

/** A row id from the query string, or null (absent or malformed). */
function idOrNull(v?: string | null): string | null {
  return v == null || v === '' ? null : toRowId(v);
}

function parseIntOrNull(v?: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** A row id in a JSON body: text, or a legacy number. Stays a string in the schema. */
const rowIdSchema = z.coerce
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, 'Invalid id');

/** Any registered scope — `isKnownDriveScope` is the gate, not a fixed enum. */
const scopeEnum = z.string().refine(isKnownDriveScope, { message: 'unknown scope' });
const visibilityEnum = z.enum(['team', 'private']);

const folderCreateSchema = z.object({
  scope: scopeEnum,
  base_id: rowIdSchema.optional(),
  owner_key: z.string().min(1).max(128).optional(),
  visibility: visibilityEnum.optional(),
  parent_id: rowIdSchema.optional(),
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
    parent_id: rowIdSchema.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.parent_id !== undefined, 'nothing to update');

const fileInitSchema = z.object({
  scope: scopeEnum,
  base_id: rowIdSchema.optional(),
  owner_key: z.string().min(1).max(128).optional(),
  visibility: visibilityEnum.optional(),
  folder_id: rowIdSchema.optional(),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  content_type: z.string().optional(),
});

// `folder_id: null` moves the file to the root; omitting a key leaves it as is.
const fileUpdateSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, 'name is required')
      .optional(),
    folder_id: rowIdSchema.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.folder_id !== undefined, 'nothing to update');

// ─── Routes ──────────────────────────────────────────────

const drive = new Hono<AppEnv>()
  // ── Folders ──
  .get('/cabinet', (c) => c.json({ scope: cabinetDriveScope() }))
  .get('/folders', async (c) => {
    const scope = parseScopeParam(c.req.query('scope'));
    if (!scope) return c.json({ error: 'invalid scope' }, 400);
    const visRaw = c.req.query('visibility');
    const keys = buildScopeKeys(c, scope, {
      base_id: idOrNull(c.req.query('base_id')),
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
      parent_id: parentParam === 'all' ? undefined : idOrNull(parentParam),
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
    await recordDriveChange(db, humanActor(getAuthUser(c), c), 'createFolder', { kind: 'folder', ...folder });
    return c.json({ folder });
  })
  .put('/folders/:id', async (c) => {
    const id = c.req.param('id');
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
      if (!sameDriveCabinet(parent, folder)) {
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
    await recordDriveChange(db, humanActor(getAuthUser(c), c), 'updateFolder', { kind: 'folder', ...result.folder });
    return c.json({ folder: result.folder });
  })
  .delete('/folders/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDb();
    const folder = await db.drive.getFolder(id);
    if (!folder) return c.json({ error: 'not found' }, 404);
    if (!canWriteDrive(await accessFor(c, toNode(folder), 'write'))) return c.json({ error: 'forbidden' }, 403);
    const result = await db.drive.deleteFolder(id);
    if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_empty' ? 409 : 404);
    await recordDriveChange(db, humanActor(getAuthUser(c), c), 'deleteFolder', { kind: 'folder', ...folder });
    return c.json({ ok: true });
  })
  .get('/breadcrumb', async (c) => {
    const folderId = idOrNull(c.req.query('folder_id'));
    if (folderId == null) return c.json({ folders: [] });
    const db = getDb();
    const folder = await db.drive.getFolder(folderId);
    if (!folder) return c.json({ error: 'not found' }, 404);
    if (!canReadDrive(await accessFor(c, toNode(folder), 'read'))) return c.json({ error: 'forbidden' }, 403);
    return c.json({ folders: await db.drive.breadcrumb(folderId) });
  })
  .get('/search', async (c) => {
    // The knowledge cabinet only: team nodes plus the caller's own personal ones.
    const query = (c.req.query('q') ?? '').trim();
    if (!query) return c.json({ folders: [], files: [] });
    const user = getAuthUser(c);
    const limit = parseIntOrNull(c.req.query('limit')) ?? undefined;
    const result = await searchCabinet({ db: getDb(), userId: user.id, actor: humanActor(user, c) }, { query, limit });
    if ('error' in result) return c.json({ error: result.error }, 400);
    return c.json(result);
  })
  // ── Files ──
  .get('/files', async (c) => {
    const scope = parseScopeParam(c.req.query('scope'));
    if (!scope) return c.json({ error: 'invalid scope' }, 400);
    const visRaw = c.req.query('visibility');
    const keys = buildScopeKeys(c, scope, {
      base_id: idOrNull(c.req.query('base_id')),
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
      folder_id: idOrNull(c.req.query('folder_id')),
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
    // The target folder must sit in the same cabinet the file is filed under.
    if (folder_id) {
      const folder = await getDb().drive.getFolder(folder_id);
      if (!folder || !sameDriveCabinet(folder, keys)) return c.json({ error: 'folder not found' }, 404);
    }

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
    const id = c.req.param('id');
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
    if (completed) {
      await recordDriveChange(
        db,
        humanActor(getAuthUser(c), c),
        'uploadFile',
        { kind: 'file', ...completed },
        { size },
      );
    }
    return c.json({ file: completed ?? file });
  })
  .put(
    '/files/:id/content',
    bodyLimit({
      maxSize: MAX_DRIVE_FILE_SIZE,
      onError: (c) => c.json({ error: 'file too large' }, 413),
    }),
    async (c) => {
      const id = c.req.param('id');
      const db = getDb();
      const file = await db.drive.getFile(id);
      if (!file) return c.json({ error: 'not found' }, 404);
      if (!canWriteDrive(await accessFor(c, toNode(file), 'write'))) return c.json({ error: 'forbidden' }, 403);

      const buffer = Buffer.from(await c.req.arrayBuffer());
      await putObjectAtKey(file.cos_key, buffer, safeDriveContentType(file.name));
      const completed = await db.drive.completeFile(id, { size: buffer.length });
      if (completed) {
        await recordDriveChange(
          db,
          humanActor(getAuthUser(c), c),
          'uploadFile',
          { kind: 'file', ...completed },
          {
            size: buffer.length,
          },
        );
      }
      return c.json({ file: completed ?? file });
    },
  )
  .get('/files/:id/content', async (c) => {
    const id = c.req.param('id');
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
  .put('/files/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = fileUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid input' }, 400);

    const db = getDb();
    const file = await db.drive.getFile(id);
    if (!file || file.status !== 'active') return c.json({ error: 'not found' }, 404);
    if (!canWriteDrive(await accessFor(c, toNode(file), 'write'))) return c.json({ error: 'forbidden' }, 403);

    const { name, folder_id } = parsed.data;
    // A rename may not turn a document into something the upload policy refuses
    // (an .html or .exe would still download as an attachment, but it should
    // never have been accepted in the first place).
    if (name !== undefined) {
      const valid = validateDriveUpload({ name, size: file.size });
      if (!valid.ok) return c.json({ error: valid.error }, 400);
    }
    // Same rule as a folder move: both ends authorized, never across cabinets.
    if (folder_id != null) {
      const folder = await db.drive.getFolder(folder_id);
      if (!folder) return c.json({ error: 'folder not found' }, 404);
      if (!sameDriveCabinet(folder, file)) return c.json({ error: 'folder is in a different scope' }, 400);
      if (!canWriteDrive(await accessFor(c, toNode(folder), 'write'))) return c.json({ error: 'forbidden' }, 403);
    }

    const updated = await db.drive.updateFile(id, { name, folder_id });
    if (!updated) return c.json({ error: 'not found' }, 404);
    await recordDriveChange(db, humanActor(getAuthUser(c), c), 'updateFile', { kind: 'file', ...updated });
    return c.json({ file: updated });
  })
  .delete('/files/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDb();
    const file = await db.drive.getFile(id);
    if (!file) return c.json({ error: 'not found' }, 404);
    if (!canWriteDrive(await accessFor(c, toNode(file), 'write'))) return c.json({ error: 'forbidden' }, 403);

    await db.drive.softDeleteFile(id);
    // Best-effort object GC; the row already dropped from listings.
    deleteObjectAtKey(file.cos_key).catch((err) =>
      logger.warn(`[Drive] object GC failed for ${file.cos_key}: ${toErrorMessage(err)}`),
    );
    if (file.status === 'active') {
      await recordDriveChange(db, humanActor(getAuthUser(c), c), 'deleteFile', { kind: 'file', ...file });
    }
    return c.json({ ok: true });
  });

export default drive;
