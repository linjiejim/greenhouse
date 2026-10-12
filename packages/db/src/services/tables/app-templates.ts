/** Immutable template versions. API owns policy/scan; publication is serialized by stable key. */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { compareSemver, isValidSemver, parseSemver } from '@greenhouse/utils/semver';
import type { Db } from '../../client.js';
import { tableAppTemplates, tableAppTemplateVersions } from '../../schema/index.js';
import { TablesValidationError } from './shared.js';

type NewTemplate = typeof tableAppTemplates.$inferInsert;
type NewVersion = typeof tableAppTemplateVersions.$inferInsert;
export const templateContentHash = (content: string) => createHash('sha256').update(content).digest('hex');
export function createTablesAppTemplates(db: Db) {
  return {
    async listAppTemplates() {
      return db.select().from(tableAppTemplates).orderBy(desc(tableAppTemplates.updated_at));
    },
    async getAppTemplate(key: string) {
      return (await db.select().from(tableAppTemplates).where(eq(tableAppTemplates.key, key)).limit(1))[0];
    },
    async listAppTemplateVersions(templateId: number) {
      return db
        .select()
        .from(tableAppTemplateVersions)
        .where(eq(tableAppTemplateVersions.template_id, templateId))
        .orderBy(desc(tableAppTemplateVersions.id));
    },
    async getAppTemplateVersion(templateId: number, version: string) {
      const row = (
        await db
          .select()
          .from(tableAppTemplateVersions)
          .where(
            and(eq(tableAppTemplateVersions.template_id, templateId), eq(tableAppTemplateVersions.version, version)),
          )
          .limit(1)
      )[0];
      if (row && templateContentHash(row.content) !== row.content_hash)
        throw new TablesValidationError('Template content hash mismatch');
      return row;
    },
    async publishAppTemplateVersion(
      template: Omit<NewTemplate, 'id' | 'created_at' | 'updated_at'>,
      version: Omit<NewVersion, 'id' | 'template_id' | 'content_hash' | 'published_at'>,
      expectedLatest: string | null,
    ) {
      if (!isValidSemver(version.version) || !Object.values(parseSemver(version.version)!).every(Number.isSafeInteger))
        throw new TablesValidationError('Version must be strict semver');
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app-template:${template.key}`}))`);
        const existing = (
          await tx.select().from(tableAppTemplates).where(eq(tableAppTemplates.key, template.key)).limit(1)
        )[0];
        if ((existing?.latest_version ?? null) !== expectedLatest || (existing && !expectedLatest))
          throw new TablesValidationError('Template changed; reload before publishing');
        if (existing?.latest_version && compareSemver(version.version, existing.latest_version) <= 0)
          throw new TablesValidationError('Version must be newer than the latest version');
        const at = nowIso();
        const row =
          existing ??
          (
            await tx
              .insert(tableAppTemplates)
              .values({ ...template, created_at: at, updated_at: at })
              .returning()
          )[0]!;
        await tx.insert(tableAppTemplateVersions).values({
          ...version,
          template_id: row.id,
          content_hash: templateContentHash(version.content),
          published_at: at,
        });
        return (
          await tx
            .update(tableAppTemplates)
            .set({
              name: template.name,
              description: template.description,
              icon: template.icon,
              accent: template.accent,
              latest_version: version.version,
              updated_at: at,
            })
            .where(eq(tableAppTemplates.id, row.id))
            .returning()
        )[0]!;
      });
    },
    async reviewAppTemplateVersion(
      templateId: number,
      version: string,
      input: { decision: 'approve' | 'reject'; userId: string; note?: string },
    ) {
      return (
        await db
          .update(tableAppTemplateVersions)
          .set({
            review_status: input.decision === 'approve' ? 'approved' : 'rejected',
            reviewed_by: input.userId,
            reviewed_at: nowIso(),
            review_note: input.note ?? null,
          })
          .where(
            and(eq(tableAppTemplateVersions.template_id, templateId), eq(tableAppTemplateVersions.version, version)),
          )
          .returning()
      )[0];
    },
    async archiveAppTemplate(templateId: number) {
      await db
        .update(tableAppTemplates)
        .set({ status: 'archived', archived_at: nowIso(), updated_at: nowIso() })
        .where(eq(tableAppTemplates.id, templateId));
    },
  };
}
