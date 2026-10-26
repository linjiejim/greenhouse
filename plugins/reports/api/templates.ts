import { reportsServices } from './services.js';
import type { ReportTemplateWithOwner } from './db/report-templates.js';
/**
 * Report templates — who may see and change them, and their API shape.
 *
 * Same rule as SkillHub publishing: every internal member may publish a team
 * template; a team template is changed by its owner or a super; a personal
 * draft is seen and changed by its owner only. The templates shipped with
 * Greenhouse have no owner, so only a super changes them. One implementation
 * for the HTTP routes and the agent tools (report_templates / report_render).
 */
import type { DatabaseProvider } from '@greenhouse/api/extension-kit';
import type { ActorContext } from '@greenhouse/api/extension-kit';
import {
  checkReportTemplateDefinition,
  REPORT_TEMPLATE_VISIBILITIES,
  type ReportTemplateDefinition,
  type ReportTemplateView,
  type ReportTemplateVisibility,
} from '@greenhouse/types/reports';
import { humanActor } from '@greenhouse/api/extension-kit';
import { recordReportTemplateChange } from './audit.js';
export interface TemplateActor {
  userId: string;
  role: string;
  /** Who the audit row names, with the request id; a person acting in the app by default. */
  audit?: ActorContext;
}
const auditActor = (actor: TemplateActor) => actor.audit ?? humanActor({ id: actor.userId });
export type TemplateErrorCode = 'invalid' | 'forbidden' | 'not_found';
export type TemplateResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      code: TemplateErrorCode;
      error: string;
      errors?: string[];
    };
const fail = (code: TemplateErrorCode, error: string, errors?: string[]) =>
  ({ ok: false, code, error, ...(errors ? { errors } : {}) }) as const;
export function canViewTemplate(
  row: Pick<ReportTemplateWithOwner, 'visibility' | 'owner_user_id'>,
  actor: TemplateActor,
) {
  return row.visibility === 'team' || row.owner_user_id === actor.userId;
}
export function canEditTemplate(
  row: Pick<ReportTemplateWithOwner, 'visibility' | 'owner_user_id'>,
  actor: TemplateActor,
) {
  if (row.visibility === 'personal') return row.owner_user_id === actor.userId;
  return actor.role === 'super' || (row.owner_user_id !== null && row.owner_user_id === actor.userId);
}
export function toTemplateView(row: ReportTemplateWithOwner, actor: TemplateActor): ReportTemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    // Stored only after checkReportTemplateDefinition, so the shapes hold.
    formats: row.formats,
    sections: row.sections,
    cover_fields: row.cover_fields,
    visibility: row.visibility,
    owner_user_id: row.owner_user_id,
    owner_name: row.owner_name,
    version: row.version,
    is_default: row.is_default,
    created_at: row.created_at,
    updated_at: row.updated_at,
    can_edit: canEditTemplate(row, actor),
  };
}
export async function listTemplates(db: DatabaseProvider, actor: TemplateActor): Promise<ReportTemplateView[]> {
  return (await reportsServices(db).reportTemplates.listVisible(actor.userId)).map((row) => toTemplateView(row, actor));
}
export async function getTemplate(
  db: DatabaseProvider,
  actor: TemplateActor,
  id: string,
): Promise<TemplateResult<ReportTemplateView>> {
  const row = await reportsServices(db).reportTemplates.get(id);
  if (!row || !canViewTemplate(row, actor)) {
    return fail('not_found', `No report template "${id}" that you can see. List the templates to find the right id.`);
  }
  return { ok: true, value: toTemplateView(row, actor) };
}
/** A definition plus where it lives; visibility defaults to the team. */
function readInput(input: unknown):
  | {
      ok: true;
      definition: ReportTemplateDefinition;
      visibility: ReportTemplateVisibility;
    }
  | {
      ok: false;
      errors: string[];
    } {
  const checked = checkReportTemplateDefinition(input);
  const raw =
    (input && typeof input === 'object' ? (input as Record<string, unknown>).visibility : undefined) ?? 'team';
  const visibility = REPORT_TEMPLATE_VISIBILITIES.find((v) => v === raw);
  const errors = checked.ok ? [] : [...checked.errors];
  if (!visibility) errors.push('visibility must be "team" or "personal".');
  if (!checked.ok || !visibility) return { ok: false, errors };
  return { ok: true, definition: checked.value, visibility };
}
export async function createTemplate(
  db: DatabaseProvider,
  actor: TemplateActor,
  input: unknown,
): Promise<TemplateResult<ReportTemplateView>> {
  const read = readInput(input);
  if (!read.ok) return fail('invalid', read.errors[0]!, read.errors);
  const row = await reportsServices(db).reportTemplates.create({
    ...read.definition,
    visibility: read.visibility,
    owner_user_id: actor.userId,
    created_by: actor.userId,
  });
  await recordReportTemplateChange(db, auditActor(actor), actor.role, 'create', row);
  return getTemplate(db, actor, row.id);
}
export async function updateTemplate(
  db: DatabaseProvider,
  actor: TemplateActor,
  id: string,
  input: unknown,
): Promise<TemplateResult<ReportTemplateView>> {
  const existing = await reportsServices(db).reportTemplates.get(id);
  if (!existing || !canViewTemplate(existing, actor)) return fail('not_found', `No report template "${id}".`);
  if (!canEditTemplate(existing, actor)) {
    return fail('forbidden', `Only the owner of "${existing.name}" (or a super admin) can change it.`);
  }
  const read = readInput(input);
  if (!read.ok) return fail('invalid', read.errors[0]!, read.errors);
  // A draft is its owner's alone, so only the owner may turn a template into one: a super
  // doing it to someone else's template would hide it from everyone, themselves included.
  // A shipped template has no owner and stays a team template.
  if (read.visibility === 'personal' && existing.visibility !== 'personal') {
    if (existing.owner_user_id === null) {
      return fail('invalid', 'A template shipped with Greenhouse stays a team template.');
    }
    if (existing.owner_user_id !== actor.userId) {
      return fail(
        'forbidden',
        `Only the owner of "${existing.name}" can make it a personal draft; it stays a team template.`,
      );
    }
  }
  const updated = await reportsServices(db).reportTemplates.update(
    id,
    { ...read.definition, visibility: read.visibility },
    actor.userId,
  );
  if (!updated) return fail('not_found', `No report template "${id}".`);
  // Named as it is now; owned by whoever owned it before (an edit never changes the owner).
  await recordReportTemplateChange(db, auditActor(actor), actor.role, 'update', {
    ...updated,
    owner_name: existing.owner_name,
  });
  return getTemplate(db, actor, id);
}
export async function deleteTemplate(
  db: DatabaseProvider,
  actor: TemplateActor,
  id: string,
): Promise<
  TemplateResult<{
    id: string;
  }>
> {
  const existing = await reportsServices(db).reportTemplates.get(id);
  if (!existing || !canViewTemplate(existing, actor)) return fail('not_found', `No report template "${id}".`);
  if (!canEditTemplate(existing, actor)) {
    return fail('forbidden', `Only the owner of "${existing.name}" (or a super admin) can delete it.`);
  }
  if (!(await reportsServices(db).reportTemplates.softDelete(id, actor.userId)))
    return fail('not_found', `No report template "${id}".`);
  await recordReportTemplateChange(db, auditActor(actor), actor.role, 'delete', existing);
  return { ok: true, value: { id } };
}
