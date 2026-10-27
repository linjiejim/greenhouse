import { reportsServices } from './services.js';
import { canViewTemplate } from './templates.js';
import type { HydrateContext, ActivityAuditRow } from '@greenhouse/api/extension-kit';
import { pluginPagePath } from '@greenhouse/types/client-routes';
import type { ReportTemplateRow } from './schema.js';
/**
 * Report template changes in the platform audit — so the Activity log says
 * who created, changed or deleted which template.
 *
 * Templates are not a registered platform application (their rule is
 * reports/templates.ts), so, like drive, the change is recorded here after it
 * succeeded, in the row shape the kernel writes:
 *
 *   person  a member changing their own template (or a super their own):
 *           `app_id='reports'`, entity `reportTemplate`, create / update /
 *           delete — shown to that member, under SkillHub;
 *   admin   a super changing a template someone else owns, or one shipped
 *           with Greenhouse: `app_id='platform'`, `updateMemberReportTemplate`
 *           / `deleteMemberReportTemplate` — an admin change, super-only.
 *
 * The summary keeps the template's name, visibility and owner (never its
 * sections), so a deleted template can still be named to those who could
 * read it. Recording never fails the change it describes.
 */

import type { DatabaseProvider } from '@greenhouse/api/extension-kit';
import type { ActorContext } from '@greenhouse/api/extension-kit';
import { logger } from '@greenhouse/api/extension-kit';
import { toErrorMessage } from '@greenhouse/api/extension-kit';

export const REPORTS_AUDIT_APP_ID = 'reports';

export const REPORT_TEMPLATE_PERSON_ACTIONS = [
  'createReportTemplate',
  'updateReportTemplate',
  'deleteReportTemplate',
] as const;

export const REPORT_TEMPLATE_ADMIN_ACTIONS = ['updateMemberReportTemplate', 'deleteMemberReportTemplate'] as const;

export type ReportTemplateChange = 'create' | 'update' | 'delete';

type AuditedTemplate = Pick<ReportTemplateRow, 'id' | 'name' | 'visibility' | 'owner_user_id'> & {
  owner_name?: string | null;
};

export async function recordReportTemplateChange(
  db: DatabaseProvider,
  actor: ActorContext,
  role: string,
  change: ReportTemplateChange,
  template: AuditedTemplate,
): Promise<void> {
  const admin = change !== 'create' && role === 'super' && template.owner_user_id !== actor.actorId;
  const summary = {
    name: template.name,
    visibility: template.visibility,
    owner_user_id: template.owner_user_id,
    ...(admin
      ? { detail: template.owner_user_id ? `owned by ${template.owner_name ?? template.owner_user_id}` : 'built-in' }
      : {}),
  };
  try {
    await db.platform.recordAudit({
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      onBehalfOfUserId: actor.onBehalfOfUserId,
      clientId: actor.clientId,
      requestId: actor.requestId,
      resource: {
        appId: admin ? 'platform' : REPORTS_AUDIT_APP_ID,
        moduleId: 'templates',
        entityId: 'reportTemplate',
        recordId: template.id,
      },
      actionId: admin
        ? change === 'update'
          ? 'updateMemberReportTemplate'
          : 'deleteMemberReportTemplate'
        : `${change}ReportTemplate`,
      capability: 'reports.templates.write',
      result: 'success',
      summary,
    });
  } catch (error) {
    logger.warn('[reports] could not record a template change in the audit', { change, error: toErrorMessage(error) });
  }
}

/**
 * A report template, named only for a viewer who may read it: as it is now
 * (team templates for everyone, a draft for its owner), or — once deleted —
 * from the name its audit kept, for whoever made the change or anyone when
 * it was a team template. A member's draft is never named to anyone else,
 * a super included — the same rule as reading it.
 */
export async function reportTemplateTarget(
  ctx: HydrateContext,
  row: ActivityAuditRow,
  summary: Record<string, unknown>,
) {
  const url = pluginPagePath('reports', 'reports');
  try {
    const live = row.record_id ? await reportsServices(ctx.db).reportTemplates.get(row.record_id) : null;
    if (live)
      return canViewTemplate(live, { userId: ctx.viewer.id, role: ctx.viewer.role }) ? { label: live.name, url } : null;
  } catch {
    // Fall back to the kept name.
  }
  if (typeof summary.name !== 'string' || !summary.name) return null;
  const readable = summary.visibility === 'team' || ctx.viewer.id === row.actor_id;
  return readable ? { label: summary.name, url: null } : null;
}
