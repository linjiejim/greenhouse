/**
 * Drive service — generic folder/file cabinet over `folders` and the drive rows
 * of `files` (source = 'drive').
 *
 * Scope-agnostic: callers pass `scope` plus the scope's owner keys
 * (visibility + owner_user_id for kb; base_id for tables).
 * Access control lives in the route/tool layer (resolveDriveAccess), not here —
 * this service is pure data.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { files as driveFiles, folders as driveFolders, kbDocuments } from '../schema/index.js';
import type { DriveFolderRow, DriveScope, FileStatus } from '../schema/files.js';

/**
 * An id at this facade's edge. Ids are text; extensions written against 1.x
 * may still hold numbers, so every id parameter accepts both.
 */
export type DriveId = string | number;

function toId(value: DriveId): string;
function toId(value: DriveId | null | undefined): string | null | undefined;
function toId(value: DriveId | null | undefined): string | null | undefined {
  return value == null ? value : String(value);
}

/**
 * A drive file as this facade returns it — the drive row of `files` under the
 * field names extensions read (`cos_key` = storage_key, `uploaded_by` = created_by).
 */
export interface DriveFileRow {
  id: string;
  scope: DriveScope;
  folder_id: string | null;
  name: string;
  /** Server-generated object key. */
  cos_key: string;
  content_type: string | null;
  size: number;
  status: FileStatus;
  visibility: DriveFolderRow['visibility'];
  owner_user_id: string | null;
  base_id: string | null;
  owner_key: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

const fileColumns = {
  id: driveFiles.id,
  scope: driveFiles.scope,
  folder_id: driveFiles.folder_id,
  name: driveFiles.name,
  cos_key: driveFiles.storage_key,
  content_type: driveFiles.content_type,
  size: driveFiles.size,
  status: driveFiles.status,
  visibility: driveFiles.visibility,
  owner_user_id: driveFiles.owner_user_id,
  base_id: driveFiles.base_id,
  owner_key: driveFiles.owner_key,
  uploaded_by: driveFiles.created_by,
  created_at: driveFiles.created_at,
  updated_at: driveFiles.updated_at,
};

type SelectedFile = Omit<DriveFileRow, 'scope' | 'cos_key'> & { scope: string | null; cos_key: string | null };

/** Drive rows always carry a scope and an object key (CHECK chk_files_source_owner). */
function toDriveFile(row: SelectedFile): DriveFileRow {
  return { ...row, scope: row.scope ?? '', cos_key: row.cos_key ?? '' };
}

const isDrive = eq(driveFiles.source, 'drive');

export interface DriveFolderInput {
  scope: DriveScope;
  parent_id?: DriveId | null;
  name: string;
  visibility?: DriveFolderRow['visibility'];
  owner_user_id?: string | null;
  base_id?: DriveId | null;
  /** Owner of an extension scope — opaque to core. */
  owner_key?: string | null;
  created_by?: string | null;
}

export interface DriveFolderListOpts {
  scope: DriveScope;
  /** null = root folders only; undefined = any depth. */
  parent_id?: DriveId | null;
  base_id?: DriveId | null;
  owner_key?: string | null;
  visibility?: DriveFolderRow['visibility'];
  owner_user_id?: string | null;
}

export interface DriveFileInput {
  scope: DriveScope;
  folder_id?: DriveId | null;
  name: string;
  /** Server-generated object key — never derived from user input. */
  cos_key: string;
  content_type?: string | null;
  size?: number;
  visibility?: DriveFileRow['visibility'];
  owner_user_id?: string | null;
  base_id?: DriveId | null;
  owner_key?: string | null;
  uploaded_by?: string | null;
}

export interface DriveFileListOpts {
  scope: DriveScope;
  /** null = files at the scope/owner root; undefined = any folder. */
  folder_id?: DriveId | null;
  base_id?: DriveId | null;
  owner_key?: string | null;
  visibility?: DriveFileRow['visibility'];
  owner_user_id?: string | null;
}

export function createDriveService(db: Db) {
  const service = {
    async createFolder(input: DriveFolderInput): Promise<DriveFolderRow> {
      const now = nowIso();
      const [row] = await db
        .insert(driveFolders)
        .values({
          id: newId('folder'),
          scope: input.scope,
          parent_id: toId(input.parent_id) ?? null,
          name: input.name,
          visibility: input.visibility ?? null,
          owner_user_id: input.owner_user_id ?? null,
          base_id: toId(input.base_id) ?? null,
          owner_key: input.owner_key ?? null,
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async listFolders(opts: DriveFolderListOpts): Promise<DriveFolderRow[]> {
      const conditions = [eq(driveFolders.scope, opts.scope)];
      if (opts.parent_id === null) conditions.push(isNull(driveFolders.parent_id));
      else if (opts.parent_id !== undefined) conditions.push(eq(driveFolders.parent_id, toId(opts.parent_id)));
      if (opts.base_id != null) conditions.push(eq(driveFolders.base_id, toId(opts.base_id)));
      if (opts.owner_key != null) conditions.push(eq(driveFolders.owner_key, opts.owner_key));
      if (opts.visibility) conditions.push(eq(driveFolders.visibility, opts.visibility));
      if (opts.owner_user_id != null) conditions.push(eq(driveFolders.owner_user_id, opts.owner_user_id));
      // (sort_order, name): every row defaults to 0, so a tree nobody has dragged
      // stays alphabetical and the tables scope is unaffected.
      return db
        .select()
        .from(driveFolders)
        .where(and(...conditions))
        .orderBy(asc(driveFolders.sort_order), asc(driveFolders.name), asc(driveFolders.created_at));
    },

    /**
     * Write a manual sibling order: `ids` in display order become sort_order
     * 1..n in ONE statement (atomic without a transaction). Caller owns the
     * authorization and the "these really are siblings" check — this is pure data.
     */
    async reorderFolders(ids: DriveId[]): Promise<void> {
      if (ids.length === 0) return;
      const pairs = ids.map((id, i) => sql`(${toId(id)}::text, ${i + 1}::int)`);
      await db.execute(sql`
        UPDATE ${driveFolders} SET sort_order = v.ord
        FROM (VALUES ${sql.join(pairs, sql`, `)}) AS v(id, ord)
        WHERE ${driveFolders.id} = v.id
      `);
    },

    async getFolder(id: DriveId): Promise<DriveFolderRow | undefined> {
      const rows = await db
        .select()
        .from(driveFolders)
        .where(eq(driveFolders.id, toId(id)))
        .limit(1);
      return rows[0];
    },

    /** Ancestor chain root→…→folder, for breadcrumb navigation. */
    async breadcrumb(folderId: DriveId): Promise<DriveFolderRow[]> {
      const chain: DriveFolderRow[] = [];
      let current = await service.getFolder(folderId);
      // Cap the walk so a corrupt parent loop can never hang the request.
      for (let i = 0; current && i < 64; i++) {
        chain.unshift(current);
        current = current.parent_id != null ? await service.getFolder(current.parent_id) : undefined;
      }
      return chain;
    },

    /**
     * Record an upload intent. The row starts `pending`: the bytes are uploaded
     * out-of-band (presigned PUT direct to COS, or the proxy endpoint), then
     * confirmed via completeFile. Pending rows are never listed or served.
     */
    async initFile(input: DriveFileInput): Promise<DriveFileRow> {
      const now = nowIso();
      const [row] = await db
        .insert(driveFiles)
        .values({
          id: newId('file'),
          source: 'drive',
          scope: input.scope,
          folder_id: toId(input.folder_id) ?? null,
          name: input.name,
          storage_key: input.cos_key,
          content_type: input.content_type ?? null,
          size: input.size ?? 0,
          status: 'pending',
          visibility: input.visibility ?? null,
          owner_user_id: input.owner_user_id ?? null,
          base_id: toId(input.base_id) ?? null,
          owner_key: input.owner_key ?? null,
          created_by: input.uploaded_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning(fileColumns);
      return toDriveFile(row!);
    },

    async listFiles(opts: DriveFileListOpts): Promise<DriveFileRow[]> {
      const conditions = [isDrive, eq(driveFiles.scope, opts.scope), eq(driveFiles.status, 'active')];
      if (opts.folder_id === null) conditions.push(isNull(driveFiles.folder_id));
      else if (opts.folder_id !== undefined) conditions.push(eq(driveFiles.folder_id, toId(opts.folder_id)));
      if (opts.base_id != null) conditions.push(eq(driveFiles.base_id, toId(opts.base_id)));
      if (opts.owner_key != null) conditions.push(eq(driveFiles.owner_key, opts.owner_key));
      if (opts.visibility) conditions.push(eq(driveFiles.visibility, opts.visibility));
      if (opts.owner_user_id != null) conditions.push(eq(driveFiles.owner_user_id, opts.owner_user_id));
      const rows = await db
        .select(fileColumns)
        .from(driveFiles)
        .where(and(...conditions))
        .orderBy(asc(driveFiles.name), asc(driveFiles.created_at));
      return rows.map(toDriveFile);
    },

    /**
     * Confirm a pending upload: flip it to `active` and record the
     * HeadObject-verified byte size (the server's truth, not the client's claim).
     * Only a `pending` row transitions; a second call is a no-op (returns undefined).
     */
    async completeFile(id: DriveId, opts: { size: number }): Promise<DriveFileRow | undefined> {
      const rows = await db
        .update(driveFiles)
        .set({ status: 'active', size: opts.size, updated_at: nowIso() })
        .where(and(eq(driveFiles.id, toId(id)), isDrive, eq(driveFiles.status, 'pending')))
        .returning(fileColumns);
      return rows[0] ? toDriveFile(rows[0]) : undefined;
    },

    /** Fetch a file row by id, any status (the route decides what to serve). */
    async getFile(id: DriveId): Promise<DriveFileRow | undefined> {
      const rows = await db
        .select(fileColumns)
        .from(driveFiles)
        .where(and(eq(driveFiles.id, toId(id)), isDrive))
        .limit(1);
      return rows[0] ? toDriveFile(rows[0]) : undefined;
    },

    /**
     * Rename and/or move an active file. `folder_id: null` moves it to the root
     * of its scope; omitting a field leaves it untouched. Like updateFolder, the
     * caller owns the scope/ownership checks on both ends — this is pure data.
     */
    async updateFile(
      id: DriveId,
      patch: { name?: string; folder_id?: DriveId | null },
    ): Promise<DriveFileRow | undefined> {
      const values: { updated_at: string; name?: string; folder_id?: string | null } = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.folder_id !== undefined) values.folder_id = toId(patch.folder_id);
      const [row] = await db
        .update(driveFiles)
        .set(values)
        .where(and(eq(driveFiles.id, toId(id)), isDrive, eq(driveFiles.status, 'active')))
        .returning(fileColumns);
      return row ? toDriveFile(row) : undefined;
    },

    /**
     * Name search over the knowledge cabinet one user may read: every team node
     * plus that user's own personal nodes (the kb access model — there is no
     * folder sharing). Newest first, capped; the caller still authorizes each row.
     */
    async searchKb(opts: {
      userId: string;
      query: string;
      limit?: number;
    }): Promise<{ folders: DriveFolderRow[]; files: DriveFileRow[] }> {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
      const pattern = `%${opts.query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const [folders, fileRows] = await Promise.all([
        db
          .select()
          .from(driveFolders)
          .where(
            and(
              eq(driveFolders.scope, 'kb'),
              sql`${driveFolders.name} ILIKE ${pattern}`,
              sql`(${driveFolders.visibility} = 'team' OR ${driveFolders.owner_user_id} = ${opts.userId})`,
            ),
          )
          .orderBy(desc(driveFolders.updated_at), desc(driveFolders.id))
          .limit(limit),
        db
          .select(fileColumns)
          .from(driveFiles)
          .where(
            and(
              isDrive,
              eq(driveFiles.scope, 'kb'),
              eq(driveFiles.status, 'active'),
              sql`${driveFiles.name} ILIKE ${pattern}`,
              sql`(${driveFiles.visibility} = 'team' OR ${driveFiles.owner_user_id} = ${opts.userId})`,
            ),
          )
          .orderBy(desc(driveFiles.updated_at), desc(driveFiles.id))
          .limit(limit),
      ]);
      return { folders, files: fileRows.map(toDriveFile) };
    },

    /**
     * The newest active knowledge-cabinet files one user may read (team files +
     * their own personal ones), for activity feeds. Bounded by `limit` (≤ 50).
     */
    async listRecentKbFiles(opts: { userId: string; limit?: number }): Promise<DriveFileRow[]> {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
      const rows = await db
        .select(fileColumns)
        .from(driveFiles)
        .where(
          and(
            isDrive,
            eq(driveFiles.scope, 'kb'),
            eq(driveFiles.status, 'active'),
            sql`(${driveFiles.visibility} = 'team' OR ${driveFiles.owner_user_id} = ${opts.userId})`,
          ),
        )
        .orderBy(desc(driveFiles.created_at), desc(driveFiles.id))
        .limit(limit);
      return rows.map(toDriveFile);
    },

    /**
     * Soft-delete: mark `deleted` so it drops out of listings while the row
     * survives for the async COS object cleanup. Returns false for an unknown id.
     */
    async softDeleteFile(id: DriveId): Promise<boolean> {
      const rows = await db
        .update(driveFiles)
        .set({ status: 'deleted', updated_at: nowIso() })
        .where(and(eq(driveFiles.id, toId(id)), isDrive))
        .returning({ id: driveFiles.id });
      return rows.length > 0;
    },

    /**
     * Rename and/or re-parent a folder. `parent_id: null` moves it to the root;
     * omitting a field leaves it untouched.
     *
     * Refuses (ok:false) a move that would corrupt the tree: into itself, or into
     * one of its own descendants (which would detach the whole subtree into an
     * unreachable cycle). Scope/visibility/owner checks belong to the caller —
     * this service stays pure data, like the rest of the module.
     */
    async updateFolder(
      rawId: DriveId,
      rawPatch: { name?: string; parent_id?: DriveId | null },
    ): Promise<{ ok: true; folder: DriveFolderRow } | { ok: false; reason: 'not_found' | 'cycle' }> {
      const id = toId(rawId);
      const patch = { name: rawPatch.name, parent_id: toId(rawPatch.parent_id) };
      const folder = await service.getFolder(id);
      if (!folder) return { ok: false, reason: 'not_found' };

      if (patch.parent_id !== undefined && patch.parent_id !== folder.parent_id) {
        if (patch.parent_id === id) return { ok: false, reason: 'cycle' };
        if (patch.parent_id != null) {
          // Walk the target's ancestor chain: hitting `id` means the target sits
          // inside the folder being moved. Capped like breadcrumb() so an already
          // corrupt chain can't hang the request.
          let cursor: string | null = patch.parent_id;
          for (let i = 0; cursor != null && i < 64; i++) {
            if (cursor === id) return { ok: false, reason: 'cycle' };
            const parent: DriveFolderRow | undefined = await service.getFolder(cursor);
            if (!parent) return { ok: false, reason: 'not_found' };
            cursor = parent.parent_id;
          }
        }
      }

      const values: Partial<DriveFolderRow> = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.parent_id !== undefined) values.parent_id = patch.parent_id;
      const [row] = await db.update(driveFolders).set(values).where(eq(driveFolders.id, id)).returning();
      return row ? { ok: true, folder: row } : { ok: false, reason: 'not_found' };
    },

    /**
     * Delete an empty folder. Refuses (ok:false) while it still holds a subfolder
     * or an active file — the caller surfaces that as a confirm/blocked state
     * rather than silently destroying contents.
     */
    async deleteFolder(rawId: DriveId): Promise<{ ok: boolean; reason?: 'not_found' | 'not_empty' }> {
      const id = toId(rawId);
      const folder = await service.getFolder(id);
      if (!folder) return { ok: false, reason: 'not_found' };

      const subfolder = await db
        .select({ id: driveFolders.id })
        .from(driveFolders)
        .where(eq(driveFolders.parent_id, id))
        .limit(1);
      if (subfolder.length > 0) return { ok: false, reason: 'not_empty' };

      const activeFile = await db
        .select({ id: driveFiles.id })
        .from(driveFiles)
        .where(and(eq(driveFiles.folder_id, id), isDrive, eq(driveFiles.status, 'active')))
        .limit(1);
      if (activeFile.length > 0) return { ok: false, reason: 'not_empty' };

      // kb scope also holds editable docs (kb_documents.folder_id). `ON DELETE SET
      // NULL` would silently orphan them to the root, so block a non-empty delete
      // here too — the doc must be moved out first (D14: docs never cascade-die).
      if (folder.scope === 'kb') {
        const attachedDoc = await db
          .select({ id: kbDocuments.id })
          .from(kbDocuments)
          .where(and(eq(kbDocuments.folder_id, id), sql`${kbDocuments.status} <> 'archived'`))
          .limit(1);
        if (attachedDoc.length > 0) return { ok: false, reason: 'not_empty' };
      }

      await db.delete(driveFolders).where(eq(driveFolders.id, id));
      return { ok: true };
    },
  };
  return service;
}

export type DriveService = ReturnType<typeof createDriveService>;
