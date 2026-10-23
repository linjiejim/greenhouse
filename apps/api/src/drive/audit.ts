/**
 * Drive changes in the platform audit — so the Activity log can say who changed
 * which file or folder, as it does for knowledge, projects and tables.
 *
 * Drive is not a registered platform application (its rule is resolveDriveAccess,
 * see access.ts), so nothing dispatches it; the routes and the Files tools record
 * their own successful writes here with the same row shape the kernel writes:
 * `app_id='drive'`, entity `file` | `folder`, the node id as record id. The
 * summary carries the node's name and owner keys, which the Activity log uses
 * to decide whether a viewer may see the name (team node, or their own).
 *
 * Recording never fails the write it describes: the change has already happened.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { ActorContext } from '@greenhouse/platform-kernel';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

export const DRIVE_AUDIT_APP_ID = 'drive';

export type DriveChangeAction =
  | 'createFolder'
  | 'updateFolder'
  | 'deleteFolder'
  | 'uploadFile'
  | 'updateFile'
  | 'deleteFile';

export interface DriveChangeNode {
  kind: 'file' | 'folder';
  id: number;
  name: string;
  scope: string;
  visibility?: 'team' | 'private' | null;
  owner_user_id?: string | null;
  base_id?: number | null;
  owner_key?: string | null;
}

export async function recordDriveChange(
  db: DatabaseProvider,
  actor: ActorContext,
  action: DriveChangeAction,
  node: DriveChangeNode,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.platform.recordAudit({
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      onBehalfOfUserId: actor.onBehalfOfUserId,
      clientId: actor.clientId,
      requestId: actor.requestId,
      resource: { appId: DRIVE_AUDIT_APP_ID, moduleId: 'files', entityId: node.kind, recordId: String(node.id) },
      actionId: action,
      capability: 'drive.files.write',
      result: 'success',
      summary: {
        name: node.name,
        scope: node.scope,
        visibility: node.visibility ?? null,
        owner_user_id: node.owner_user_id ?? null,
        ...(node.base_id != null ? { base_id: node.base_id } : {}),
        ...(node.owner_key != null ? { owner_key: node.owner_key } : {}),
        ...extra,
      },
    });
  } catch (error) {
    logger.warn('[drive] could not record a change in the audit', { action, error: toErrorMessage(error) });
  }
}
