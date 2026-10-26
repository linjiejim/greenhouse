import { registerDriveFolderContents } from '@greenhouse/db';
import { registerDrivePlacements } from '@greenhouse/types/discriminators';
import { registerDiscriminators } from '@greenhouse/types/discriminators';
/**
 * Drive access resolution — single source of truth for who can do what to a drive
 * node (folder or file), shared by every /api/drive route + tool so the paths can
 * never diverge (the knowledge module's past divergence was a cross-user leak).
 *
 * Model (mirrors knowledge-access.ts, by design):
 * - kb scope   → team nodes (visibility='team') are collaborative (every internal
 *   user reads + writes); private nodes are owner-only. Granular folder sharing is
 *   intentionally deferred — until it ships, a non-owner gets nothing.
 * - an extension scope → whatever resolver the extension registered, which is
 *   async because such a rule usually has to read something (a feature flag, a
 *   record's entity policy). Core never guesses: an unregistered scope is denied.
 */
import type { DatabaseProvider } from '@greenhouse/db';
import type { UserRole } from '@greenhouse/types/api';

export type DriveAccess = 'owner' | 'editor' | 'reader' | null;

export interface DriveAccessNode {
  scope: string;
  visibility?: 'team' | 'private' | null;
  owner_user_id?: string | null;
  base_id?: string | null;
  /** Owner of an extension scope, e.g. a CRM company id as text. */
  owner_key?: string | null;
}

// ─── Extension scopes ────────────────────────────────────

export interface DriveScopeContext {
  userId: string;
  userRole: UserRole;
  db: DatabaseProvider;
  operation: 'read' | 'write';
}

/** A drive scope owned by an extension: its id and the rule that guards it. */
export interface DriveScopeDef {
  /** Stored in `folders.scope` / `files.scope`; namespace it with your id. */
  scope: string;
  /** Reuse a legacy team/personal cabinet for Files while this scope is enabled. */
  cabinet?: boolean;
  /** `owner_key` is whatever the extension put there; return null to deny. */
  validatePlacement?: (input: import('@greenhouse/types/discriminators').DrivePlacementInput) => boolean;
  placement?: (
    input: { base_id?: string | null; visibility?: 'team' | 'private'; owner_key?: string | null },
    userId: string,
  ) => DrivePlacement | { error: string };
  hasFolderContents?: (db: import('@greenhouse/db').Db, folderId: string) => Promise<boolean>;
  authorizeSync?: (node: DriveAccessNode, userId: string) => DriveAccess;
  authorizeNode?: (node: DriveAccessNode, ctx: DriveScopeContext) => Promise<DriveAccess>;
  authorize: (ownerKey: string | null, ctx: DriveScopeContext) => Promise<DriveAccess>;
}

const extensionScopes = new Map<string, DriveScopeDef>();

export function registerDriveScopes(defs: readonly DriveScopeDef[]): void {
  for (const def of defs) {
    if (extensionScopes.has(def.scope)) throw new Error(`Drive scope "${def.scope}" is already registered`);
    if (def.cabinet && [...extensionScopes.values()].some((scope) => scope.cabinet))
      throw new Error('Only one plugin file cabinet may be selected');
    extensionScopes.set(def.scope, def);
    if (def.hasFolderContents) registerDriveFolderContents(def.scope, def.hasFolderContents);
    registerDiscriminators({ folderScopes: [def.scope] });
    if (def.validatePlacement) registerDrivePlacements([{ scope: def.scope, validate: def.validatePlacement }]);
  }
}

export function isKnownDriveScope(scope: string): boolean {
  return scope === 'drive' || extensionScopes.has(scope);
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
export async function resolveDriveAccessAsync(node: DriveAccessNode, ctx: DriveScopeContext): Promise<DriveAccess> {
  const def = extensionScopes.get(node.scope);
  if (def) return def.authorizeNode ? def.authorizeNode(node, ctx) : def.authorize(node.owner_key ?? null, ctx);
  return resolveDriveAccess(node, ctx.userId, {});
}

export function resolveDriveAccess(node: DriveAccessNode, userId: string, _ctx: object): DriveAccess {
  if (node.scope === 'drive')
    return node.owner_user_id === userId ? 'owner' : node.visibility === 'team' ? 'editor' : null;
  return extensionScopes.get(node.scope)?.authorizeSync?.(node, userId) ?? null;
}

/** Read (list / download). */
export const canReadDrive = (access: DriveAccess): boolean => access !== null;

/** Mutate (upload / move / rename / delete). */
export const canWriteDrive = (access: DriveAccess): boolean => access === 'owner' || access === 'editor';

/**
 * Whether two nodes live in the same cabinet — same scope and the same owner
 * keys. A move may never cross cabinets (kb team ↔ personal, one Base's files ↔
 * another's): a writable source would otherwise lift a node into a foreign tree.
 */
export function sameDriveCabinet(
  a: Pick<DriveAccessNode, 'scope' | 'visibility' | 'owner_user_id' | 'base_id' | 'owner_key'>,
  b: Pick<DriveAccessNode, 'scope' | 'visibility' | 'owner_user_id' | 'base_id' | 'owner_key'>,
): boolean {
  return (
    a.scope === b.scope &&
    (a.visibility ?? null) === (b.visibility ?? null) &&
    (a.owner_user_id ?? null) === (b.owner_user_id ?? null) &&
    (a.base_id ?? null) === (b.base_id ?? null) &&
    (a.owner_key ?? null) === (b.owner_key ?? null)
  );
}

export interface DrivePlacement {
  base_id: string | null;
  visibility: 'team' | 'private' | null;
  owner_user_id: string | null;
  owner_key: string | null;
}
export function extensionDrivePlacement(
  scope: string,
  input: { base_id?: string | null; visibility?: 'team' | 'private'; owner_key?: string | null },
  userId: string,
): DrivePlacement | { error: string } {
  if (scope === 'drive')
    return {
      base_id: null,
      owner_key: null,
      visibility: input.visibility ?? 'team',
      owner_user_id: input.visibility === 'private' ? userId : null,
    };
  const def = extensionScopes.get(scope);
  if (!def) return { error: 'unknown scope' };
  if (def.placement) return def.placement(input, userId);
  if (!input.owner_key) return { error: `owner_key is required for the ${scope} scope` };
  return { base_id: null, visibility: null, owner_user_id: null, owner_key: input.owner_key };
}

export function cabinetDriveScope(): string {
  return [...extensionScopes.values()].find((scope) => scope.cabinet)?.scope ?? 'drive';
}
