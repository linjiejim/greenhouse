import {
  templateContentHash,
  type DatabaseProvider,
  type TableAppTemplateRow,
  type TableAppTemplateVersionRow,
} from '@greenhouse/db';
import { nowIso } from '@greenhouse/utils/date';
import type { AppTemplateSummary, AppTemplateVersionView } from '@greenhouse/types/apps';
import { appTemplates, templateLocale } from './index.js';
import { checkTemplateContent, type TemplateContent } from './content.js';

export function readTemplateContent(row: TableAppTemplateVersionRow): TemplateContent {
  if (templateContentHash(row.content) !== row.content_hash) throw new Error('Template content hash mismatch');
  return JSON.parse(row.content) as TemplateContent;
}
export function templateInstallable(version: TableAppTemplateVersionRow): boolean {
  return (
    version.review_status === 'approved' ||
    (version.review_status === 'not_required' && version.scan_status === 'clean')
  );
}
export function templateSummary(
  row: TableAppTemplateRow,
  version: TableAppTemplateVersionRow,
  locale?: string | null,
): AppTemplateSummary {
  const content = readTemplateContent(version);
  const lang = templateLocale(locale);
  return {
    key: row.key,
    name: content.name[lang],
    description: content.description[lang],
    icon: row.icon,
    accent: row.accent,
    source: row.source,
    version: version.version,
    reviewStatus: version.review_status,
  };
}
export async function templateVersionView(
  db: DatabaseProvider,
  row: TableAppTemplateVersionRow,
): Promise<AppTemplateVersionView> {
  const publisher = row.published_by ? await db.users.getById(row.published_by) : undefined;
  const reviewer = row.reviewed_by ? await db.users.getById(row.reviewed_by) : undefined;
  return {
    version: row.version,
    changelog: row.changelog,
    contentHash: row.content_hash,
    scanStatus: row.scan_status,
    reviewStatus: row.review_status,
    carries: { customCards: row.custom_cards, automations: row.automations },
    publishedBy: publisher ? { id: publisher.id, name: publisher.nickname } : null,
    publishedAt: row.published_at,
    ...(reviewer ? { reviewedBy: { id: reviewer.id, name: reviewer.nickname } } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.review_note ? { reviewNote: row.review_note } : {}),
  };
}
/** Idempotent repository sync; editing bytes requires an explicit builtin version bump. */
export async function syncBuiltinAppTemplates(db: DatabaseProvider): Promise<void> {
  for (const template of appTemplates().values()) {
    const version = '1.0.0';
    const content: TemplateContent = {
      name: template.name,
      description: template.description,
      plans: template.plans,
      appRef: template.appRef,
    };
    const checked = checkTemplateContent(content);
    const existing = await db.tables.getAppTemplate(template.key);
    if (existing) {
      if (existing.source !== 'builtin') throw new Error(`Reserved template key: ${template.key}`);
      const stored = await db.tables.getAppTemplateVersion(existing.id, version);
      if (stored) {
        if (stored.content_hash !== templateContentHash(checked.content))
          throw new Error(`Builtin template ${template.key} changed without a version bump`);
        continue;
      }
    }
    try {
      await db.tables.publishAppTemplateVersion(
        {
          key: template.key,
          source: 'builtin',
          name: template.name.en,
          description: template.description.en,
          icon: template.icon,
          accent: template.accent,
        },
        {
          version,
          content: checked.content,
          custom_cards: checked.customCards,
          automations: checked.automations,
          scan_status: checked.scan.status,
          scan_findings: checked.scan.findings,
          scanned_at: nowIso(),
          review_status: 'approved',
          review_note: 'Repository-reviewed builtin template',
        },
        existing?.latest_version ?? null,
      );
    } catch (error) {
      // Concurrent first requests may sync the same catalog. Only identical content is success.
      const row = await db.tables.getAppTemplate(template.key);
      const stored = row && (await db.tables.getAppTemplateVersion(row.id, version));
      if (!stored || row?.source !== 'builtin' || stored.content_hash !== templateContentHash(checked.content))
        throw error;
    }
  }
}
