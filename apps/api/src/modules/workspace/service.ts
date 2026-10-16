import { and, eq, sql } from 'drizzle-orm';
import { getDb, members, transaction, workspace, type Db, type WorkspaceRow } from '@greenhouse/db';
import { API_VERSION, type Bootstrap, type BrandingInput } from '@greenhouse/contract';
import { audit, changedFields } from '../../audit.js';
import type { FilesService } from '../files/service.js';

export const WORKSPACE_ID = 'default';

export function createWorkspaceService(deps: { files: FilesService }) {
  async function row(db: Db = getDb()): Promise<WorkspaceRow> {
    const [existing] = await db.select().from(workspace).where(eq(workspace.id, WORKSPACE_ID)).limit(1);
    if (existing) return existing;
    const [created] = await db.insert(workspace).values({ id: WORKSPACE_ID }).onConflictDoNothing().returning();
    return created ?? (await row(db));
  }

  return {
    row,

    async bootstrap(): Promise<Bootstrap> {
      const db = getDb();
      const current = await row(db);
      const [admin] = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.role, 'admin'), eq(members.status, 'active')))
        .limit(1);
      return {
        api_version: API_VERSION,
        name: current.name,
        primary_color: current.primaryColor,
        // The sign-in page shows it before anyone signs in: its URL names no member.
        logo_url: current.logoFileId ? deps.files.signedUrl(current.logoFileId, null).url : null,
        login_methods: ['password'],
        setup_pending: !admin,
      };
    },

    /** A new logo must be an image the admin uploaded with purpose `branding`; the one it replaces is deleted. */
    async updateBranding(input: BrandingInput, memberId: string): Promise<Bootstrap> {
      const before = await row();
      if (input.logo_file_id) await deps.files.ownPicture(memberId, input.logo_file_id, 'branding');
      await transaction(async (db) => {
        await db
          .update(workspace)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.primary_color !== undefined ? { primaryColor: input.primary_color } : {}),
            ...(input.logo_file_id !== undefined ? { logoFileId: input.logo_file_id } : {}),
            updatedBy: memberId,
            updatedAt: sql`now()`,
          })
          .where(eq(workspace.id, WORKSPACE_ID));
        await audit({
          actorId: memberId,
          action: 'workspace.branding',
          resourceType: 'workspace',
          resourceId: WORKSPACE_ID,
          summary: changedFields(input),
        });
      });
      if (input.logo_file_id !== undefined && before.logoFileId && before.logoFileId !== input.logo_file_id) {
        await deps.files.discard(before.logoFileId);
      }
      return this.bootstrap();
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
