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

import type { DatabaseProvider, ReportTemplateRow } from '@greenhouse/db';
import type { ActorContext } from '@greenhouse/platform-kernel';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

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
