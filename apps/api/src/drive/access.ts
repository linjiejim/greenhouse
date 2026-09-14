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
 * - an extension scope → whatever resolver the extension registered, which is
 *   async because such a rule usually has to read something (a feature flag, a
 *   record's entity policy). Core never guesses: an unregistered scope is denied.
 */
import type { DatabaseProvider } from '@greenhouse/db';

export type DriveAccess = 'owner' | 'editor' | 'reader' | null;

export interface DriveAccessNode {
  scope: string;
  visibility?: 'team' | 'private' | null;
  owner_user_id?: string | null;
  base_id?: number | null;
  /** Owner of an extension scope, e.g. a CRM company id as text. */
  owner_key?: string | null;
}

// ─── Extension scopes ────────────────────────────────────

export interface DriveScopeContext {
  userId: string;
  userRole: string;
  db: DatabaseProvider;
  operation: 'read' | 'write';
}

/** A drive scope owned by an extension: its id and the rule that guards it. */
export interface DriveScopeDef {
  /** Stored in `drive_folders.scope` / `drive_files.scope`; namespace it with your id. */
  scope: string;
  /** `owner_key` is whatever the extension put there; return null to deny. */
  authorize: (ownerKey: string | null, ctx: DriveScopeContext) => Promise<DriveAccess>;
}

const extensionScopes = new Map<string, DriveScopeDef>();

export function registerDriveScopes(defs: readonly DriveScopeDef[]): void {
  for (const def of defs) {
    if (def.scope === 'kb' || def.scope === 'tables') throw new Error(`Drive scope "${def.scope}" is owned by core`);
    if (extensionScopes.has(def.scope)) throw new Error(`Drive scope "${def.scope}" is already registered`);
    extensionScopes.set(def.scope, def);
  }
}

export function isKnownDriveScope(scope: string): boolean {
  return scope === 'kb' || scope === 'tables' || extensionScopes.has(scope);
}

export function extensionDriveScopes(): readonly DriveScopeDef[] {
  return [...extensionScopes.values()];
}

/** Test hook — forget scopes registered by a suite. */
export function _resetExtensionDriveScopes(): void {
  extensionScopes.clear();
}

/**
 * Authorize a node in any scope. Core's two resolve synchronously through
 * {@link resolveDriveAccess}; an extension scope goes to its own resolver.
 */
export async function resolveDriveAccessAsync(
  node: DriveAccessNode,
  ctx: DriveScopeContext & { tablesRole?: 'owner' | 'builder' | 'editor' | 'viewer' | null },
): Promise<DriveAccess> {
  const def = extensionScopes.get(node.scope);
  if (def) return def.authorize(node.owner_key ?? null, ctx);
  return resolveDriveAccess(node, ctx.userId, { tablesRole: ctx.tablesRole });
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

  // An extension scope never resolves here — `resolveDriveAccessAsync` routes it
  // to the owning extension first, so reaching this point means "unknown scope".
  if (node.scope !== 'kb') return null;

  // kb scope
  if (node.owner_user_id === userId) return 'owner';
  if (node.visibility === 'team') return 'editor';
  return null; // private node owned by someone else (no folder sharing yet)
}

/** Read (list / download). */
export const canReadDrive = (access: DriveAccess): boolean => access !== null;

/** Mutate (upload / move / rename / delete). */
export const canWriteDrive = (access: DriveAccess): boolean => access === 'owner' || access === 'editor';
