/**
 * Who may do what, beyond the `assets.*` capabilities the runtime checks: every member with
 * the `assets` feature sees, uploads and files assets into collections; people who uploaded
 * an asset edit it; `assets_manage` (and supers) edit and delete anything and run the library.
 */
import { userHasFeature, type UserRole } from '@greenhouse/api/extension-kit';
import type { AssetRow } from './schema.js';
import { assetStore } from './services.js';

export const ASSETS_FEATURE = 'assets';
export const MANAGE_FEATURE = 'assets_manage';

export interface Member {
  id: string;
  role: UserRole;
}

export function canManage(member: Member): Promise<boolean> {
  return userHasFeature(member.id, member.role, MANAGE_FEATURE);
}

/** The first uploader and anyone who uploaded the same file later, or a manager. */
export async function canEdit(member: Member, asset: AssetRow): Promise<boolean> {
  if (asset.uploaded_by === member.id) return true;
  if (await canManage(member)) return true;
  return (await assetStore().uploaders(asset.id)).some((u) => u.user_id === member.id);
}
