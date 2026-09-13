/**
 * Drive service — generic folder/file cabinet over drive_folders/drive_files.
 *
 * Scope-agnostic: callers pass `scope` plus the scope's owner keys
 * (visibility + owner_user_id for kb; base_id for tables).
 * Access control lives in the route/tool layer (resolveDriveAccess), not here —
 * this service is pure data.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { driveFiles, driveFolders, knowledgeBase } from '../schema/index.js';
import type { DriveFileRow, DriveFolderRow, DriveScope } from '../schema/drive.js';

export interface DriveFolderInput {
  scope: DriveScope;
  parent_id?: number | null;
  name: string;
  visibility?: DriveFolderRow['visibility'];
  owner_user_id?: string | null;
  base_id?: number | null;
  created_by?: string | null;
}

export interface DriveFolderListOpts {
  scope: DriveScope;
  /** null = root folders only; undefined = any depth. */
  parent_id?: number | null;
  base_id?: number | null;
  visibility?: DriveFolderRow['visibility'];
  owner_user_id?: string | null;
}

export interface DriveFileInput {
  scope: DriveScope;
  folder_id?: number | null;
  name: string;
  /** Server-generated object key — never derived from user input. */
  cos_key: string;
  content_type?: string | null;
  size?: number;
  visibility?: DriveFileRow['visibility'];
  owner_user_id?: string | null;
  base_id?: number | null;
  uploaded_by?: string | null;
}

export interface DriveFileListOpts {
  scope: DriveScope;
  /** null = files at the scope/owner root; undefined = any folder. */
  folder_id?: number | null;
  base_id?: number | null;
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
          scope: input.scope,
          parent_id: input.parent_id ?? null,
          name: input.name,
          visibility: input.visibility ?? null,
          owner_user_id: input.owner_user_id ?? null,
          base_id: input.base_id ?? null,
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
      else if (opts.parent_id !== undefined) conditions.push(eq(driveFolders.parent_id, opts.parent_id));
      if (opts.base_id != null) conditions.push(eq(driveFolders.base_id, opts.base_id));
      if (opts.visibility) conditions.push(eq(driveFolders.visibility, opts.visibility));
      if (opts.owner_user_id != null) conditions.push(eq(driveFolders.owner_user_id, opts.owner_user_id));
      // (sort_order, name): every row defaults to 0, so a tree nobody has dragged
      // stays alphabetical and the tables scope is unaffected.
      return db
        .select()
        .from(driveFolders)
        .where(and(...conditions))
        .orderBy(asc(driveFolders.sort_order), asc(driveFolders.name));
    },

    /**
     * Write a manual sibling order: `ids` in display order become sort_order
     * 1..n in ONE statement (atomic without a transaction). Caller owns the
     * authorization and the "these really are siblings" check — this is pure data.
     */
    async reorderFolders(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      const pairs = ids.map((id, i) => sql`(${id}::int, ${i + 1}::int)`);
      await db.execute(sql`
        UPDATE ${driveFolders} SET sort_order = v.ord
        FROM (VALUES ${sql.join(pairs, sql`, `)}) AS v(id, ord)
        WHERE ${driveFolders.id} = v.id
      `);
    },

    async getFolder(id: number): Promise<DriveFolderRow | undefined> {
      const rows = await db.select().from(driveFolders).where(eq(driveFolders.id, id)).limit(1);
      return rows[0];
    },

    /** Ancestor chain root→…→folder, for breadcrumb navigation. */
    async breadcrumb(folderId: number): Promise<DriveFolderRow[]> {
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
          scope: input.scope,
          folder_id: input.folder_id ?? null,
          name: input.name,
          cos_key: input.cos_key,
          content_type: input.content_type ?? null,
          size: input.size ?? 0,
          status: 'pending',
          visibility: input.visibility ?? null,
          owner_user_id: input.owner_user_id ?? null,
          base_id: input.base_id ?? null,
          uploaded_by: input.uploaded_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async listFiles(opts: DriveFileListOpts): Promise<DriveFileRow[]> {
      const conditions = [eq(driveFiles.scope, opts.scope), eq(driveFiles.status, 'active')];
      if (opts.folder_id === null) conditions.push(isNull(driveFiles.folder_id));
      else if (opts.folder_id !== undefined) conditions.push(eq(driveFiles.folder_id, opts.folder_id));
      if (opts.base_id != null) conditions.push(eq(driveFiles.base_id, opts.base_id));
      if (opts.visibility) conditions.push(eq(driveFiles.visibility, opts.visibility));
      if (opts.owner_user_id != null) conditions.push(eq(driveFiles.owner_user_id, opts.owner_user_id));
      return db
        .select()
        .from(driveFiles)
        .where(and(...conditions))
        .orderBy(asc(driveFiles.name));
    },

    /**
     * Confirm a pending upload: flip it to `active` and record the
     * HeadObject-verified byte size (the server's truth, not the client's claim).
     * Only a `pending` row transitions; a second call is a no-op (returns undefined).
     */
    async completeFile(id: number, opts: { size: number }): Promise<DriveFileRow | undefined> {
      const rows = await db
        .update(driveFiles)
        .set({ status: 'active', size: opts.size, updated_at: nowIso() })
        .where(and(eq(driveFiles.id, id), eq(driveFiles.status, 'pending')))
        .returning();
      return rows[0];
    },

    /** Fetch a file row by id, any status (the route decides what to serve). */
    async getFile(id: number): Promise<DriveFileRow | undefined> {
      const rows = await db.select().from(driveFiles).where(eq(driveFiles.id, id)).limit(1);
      return rows[0];
    },

    /**
     * Soft-delete: mark `deleted` so it drops out of listings while the row
     * survives for the async COS object cleanup. Returns false for an unknown id.
     */
    async softDeleteFile(id: number): Promise<boolean> {
      const rows = await db
        .update(driveFiles)
        .set({ status: 'deleted', updated_at: nowIso() })
        .where(eq(driveFiles.id, id))
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
      id: number,
      patch: { name?: string; parent_id?: number | null },
    ): Promise<{ ok: true; folder: DriveFolderRow } | { ok: false; reason: 'not_found' | 'cycle' }> {
      const folder = await service.getFolder(id);
      if (!folder) return { ok: false, reason: 'not_found' };

      if (patch.parent_id !== undefined && patch.parent_id !== folder.parent_id) {
        if (patch.parent_id === id) return { ok: false, reason: 'cycle' };
        if (patch.parent_id != null) {
          // Walk the target's ancestor chain: hitting `id` means the target sits
          // inside the folder being moved. Capped like breadcrumb() so an already
          // corrupt chain can't hang the request.
          let cursor: number | null = patch.parent_id;
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
    async deleteFolder(id: number): Promise<{ ok: boolean; reason?: 'not_found' | 'not_empty' }> {
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
        .where(and(eq(driveFiles.folder_id, id), eq(driveFiles.status, 'active')))
        .limit(1);
      if (activeFile.length > 0) return { ok: false, reason: 'not_empty' };

      // kb scope also holds editable docs (knowledge_base.folder_id). `ON DELETE SET
      // NULL` would silently orphan them to the root, so block a non-empty delete
      // here too — the doc must be moved out first (D14: docs never cascade-die).
      if (folder.scope === 'kb') {
        const attachedDoc = await db
          .select({ id: knowledgeBase.id })
          .from(knowledgeBase)
          .where(and(eq(knowledgeBase.folder_id, id), sql`${knowledgeBase.status} <> 'archived'`))
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
