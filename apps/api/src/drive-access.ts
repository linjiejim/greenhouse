/**
 * Drive access resolution — single source of truth for who can do what to a drive
 * node (folder or file), shared by every /api/drive route + tool so the paths can
 * never diverge (the knowledge module's past divergence was a cross-user leak).
 *
 * Model (mirrors knowledge-access.ts, by design):
 * - kb scope   → team nodes (visibility='team') are collaborative (every internal
 *   user reads + writes); private nodes are owner-only. Granular folder sharing is
 *   intentionally deferred — until it ships, a non-owner gets nothing.
 * - tables scope → mirrors Base role: owner, builder/editor, viewer, or denied.
 */

export type DriveAccess = 'owner' | 'editor' | 'reader' | null;

export interface DriveAccessNode {
  scope: 'kb' | 'tables';
  visibility?: 'team' | 'private' | null;
  owner_user_id?: string | null;
  base_id?: number | null;
}

export function resolveDriveAccess(
  node: DriveAccessNode,
  userId: string,
  ctx: {
    tablesRole?: 'owner' | 'builder' | 'editor' | 'viewer' | null;
  },
): DriveAccess {
  if (node.scope === 'tables') {
    if (ctx.tablesRole === 'owner') return 'owner';
    if (ctx.tablesRole === 'builder' || ctx.tablesRole === 'editor') return 'editor';
    return ctx.tablesRole === 'viewer' ? 'reader' : null;
  }

  // kb scope
  if (node.owner_user_id === userId) return 'owner';
  if (node.visibility === 'team') return 'editor';
  return null; // private node owned by someone else (no folder sharing yet)
}

/** Read (list / download). */
export const canReadDrive = (access: DriveAccess): boolean => access !== null;

/** Mutate (upload / move / rename / delete). */
export const canWriteDrive = (access: DriveAccess): boolean => access === 'owner' || access === 'editor';
