import { eq, and, ne } from 'drizzle-orm';
import type { DriveScopeDef } from '@greenhouse/api/extension-kit';
import { kbDocuments } from './schema.js';
const authorize: NonNullable<DriveScopeDef['authorizeSync']> = (node, userId) =>
  node.owner_user_id === userId ? 'owner' : node.visibility === 'team' ? 'editor' : null;
export const knowledgeDriveScope: DriveScopeDef = {
  scope: 'kb',
  cabinet: true,
  authorizeSync: authorize,
  authorize: async () => null,
  authorizeNode: async (node, ctx) => authorize(node, ctx.userId),
  validatePlacement: (i) =>
    i.base_id == null &&
    i.owner_key == null &&
    (i.visibility === 'team' || (i.visibility === 'private' && i.owner_user_id != null)),
  placement: (input, userId) => ({
    base_id: null,
    owner_key: null,
    visibility: input.visibility ?? 'team',
    owner_user_id: input.visibility === 'private' ? userId : null,
  }),
  hasFolderContents: async (db, folderId) =>
    (
      await db
        .select({ id: kbDocuments.id })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.folder_id, folderId), ne(kbDocuments.status, 'archived')))
        .limit(1)
    ).length > 0,
};
