import { activityField as field, activityIdText as idText, activityText as text } from '@greenhouse/api/extension-kit';
import type { HydrateContext, ActivityAuditRow, ActivityRunRow } from '@greenhouse/api/extension-kit';
import { toRowId } from '@greenhouse/api/extension-kit';
import { entityUrl } from '@greenhouse/types/entity-links';
import type { ActivityItem } from '@greenhouse/types/activity';
import { services } from './services.js';
async function projectReadable(ctx: HydrateContext, projectId: string) {
  const project = await services(ctx.db).projects.getProjectById(projectId);
  if (!project) return null;
  if (ctx.viewer.role === 'super' || project.visibility === 'public') return project;
  const members = await services(ctx.db).projects.getMembers(project.id);
  return members.some((member) => member.user_id === ctx.viewer.id) ? project : null;
}

async function projectTarget(ctx: HydrateContext, entity: string | null, recordId: string) {
  const id = toRowId(recordId);
  if (!id) return null;
  try {
    if (entity === 'project') {
      const project = await projectReadable(ctx, id);
      return project ? { label: project.title, url: entityUrl({ kind: 'project', id: project.id }) } : null;
    }
    if (entity === 'task') {
      const task = await services(ctx.db).projects.getTaskById(id);
      const project = task ? await projectReadable(ctx, task.project_id) : null;
      return task && project ? { label: task.title, url: entityUrl({ kind: 'project', id: project.id }) } : null;
    }
  } catch {
    // A label is a convenience; the id is always shown.
  }
  return null;
}

function keptTitle(ctx: HydrateContext, row: ActivityAuditRow, summary: Record<string, unknown>): string | null {
  if (typeof summary.title !== 'string' || !summary.title) return null;
  return ctx.viewer.id === row.actor_id || ctx.viewer.role === 'super' ? summary.title : null;
}

export async function auditTarget(ctx: HydrateContext, row: ActivityAuditRow, summary: Record<string, unknown>) {
  const named =
    row.entity_id === 'comment' && row.action_id !== 'addComment'
      ? await projectTarget(ctx, 'task', String(summary.task_id ?? ''))
      : await projectTarget(ctx, row.action_id === 'addComment' ? 'task' : row.entity_id, row.record_id ?? '');
  const kept = keptTitle(ctx, row, summary);
  return named ?? (kept ? { label: kept, url: null } : null);
}
export async function toolTarget(
  ctx: HydrateContext,
  row: ActivityRunRow,
  action: string | null,
  shape: { entity: string | null; verb: string },
): Promise<ActivityItem['target']> {
  const input = field(row.input, 'input');
  const result = field(row.output, 'result');
  const entity = shape.entity === 'project' ? 'project' : 'task';
  const id =
    action === 'project.create'
      ? idText(field(result, 'project', 'id'))
      : action === 'task.create'
        ? idText(field(result, 'task', 'id'))
        : idText(field(input, entity === 'project' ? 'project_id' : 'task_id'));
  const live = id ? await projectTarget(ctx, entity, id) : null;
  if (live) return { id, ...live };
  const kept = text(field(result, entity, 'title'), shape.verb === 'create' ? field(input, 'title') : null);
  return kept && (ctx.viewer.id === row.owner_user_id || ctx.viewer.role === 'super')
    ? { id, label: kept, url: null }
    : null;
}
