import {
  humanActor,
  scanRecentChanges,
  recentChangeDraft,
  type DatabaseProvider,
  type PlatformRuntime,
  type RecentViewer,
  type RecentChangeWindow,
  type RecentChangeLane,
} from '@greenhouse/api/extension-kit';
import type { ActivityVerb } from '@greenhouse/types/activity';
import { entityUrl } from '@greenhouse/types/entity-links';
import { taskReadAuthorizer } from './platform/application.js';
import { services } from './services.js';
const EMPTY_LANE: RecentChangeLane = { items: [], exhausted: true, frontier: null };
const PROJECT_ACTIONS: Record<string, { verb: ActivityVerb; entity: string }> = {
  project_created: { verb: 'create', entity: 'project' },
  project_updated: { verb: 'update', entity: 'project' },
  task_created: { verb: 'create', entity: 'task' },
  task_updated: { verb: 'update', entity: 'task' },
  comment_added: { verb: 'comment', entity: 'task' },
  member_added: { verb: 'update', entity: 'member' },
};

export async function projectChanges(
  db: DatabaseProvider,
  runtime: PlatformRuntime,
  viewer: RecentViewer,
  window: RecentChangeWindow,
  need: number,
): Promise<RecentChangeLane> {
  const actor = humanActor(viewer);
  const listed = await runtime.dispatch({
    actor,
    appId: 'projects',
    actionId: 'listProjects',
    payload: { limit: 500 },
  });
  if (!listed.ok) return EMPTY_LANE;
  // Project activity is what listActivities serves: a readable project AND the
  // collaboration read capability.
  if (!(await runtime.authorize(actor, 'projects.collaboration.read')).allowed) return EMPTY_LANE;
  const projects = (listed.data as { projects: Array<{ id: string | number; title: string }> }).projects;
  const titles = new Map(projects.map((project) => [String(project.id), project.title]));

  // A row about a task shows only when that task is readable: the execution
  // read capability, then the same task rule listTasks applies (project
  // readability + task entity policy), for just the tasks these rows name, with
  // the user / policy / project lookups made once for the whole request.
  const canReadTasks = (await runtime.authorize(actor, 'projects.execution.read')).allowed;
  const canRead = taskReadAuthorizer({ db }, actor);
  const taskTitles = new Map<string, string | null>();

  return scanRecentChanges(
    window,
    need,
    (cursor, limit) =>
      services(db).projects.recentProjectActivities({
        projectIds: [...titles.keys()],
        since: window.since,
        cursor,
        limit,
      }),
    async (fetched) => {
      if (canReadTasks) {
        for (const id of new Set(fetched.map((row) => row.task_id))) {
          if (id === null || taskTitles.has(id)) continue;
          const task = await services(db).projects.getTaskById(id);
          taskTitles.set(id, task && (await canRead(task)) ? task.title : null);
        }
      }
      return fetched
        .filter((row) => row.task_id === null || (taskTitles.get(row.task_id) ?? null) !== null)
        .map((row) => {
          const kind = PROJECT_ACTIONS[row.action] ?? { verb: 'update' as const, entity: 'project' };
          const label = row.task_id ? (taskTitles.get(row.task_id) ?? null) : (titles.get(row.project_id) ?? null);
          return recentChangeDraft({
            id: row.key,
            source: 'person',
            at: row.at,
            actorId: row.user_id,
            module: 'projects',
            verb: kind.verb,
            entity: row.task_id ? 'task' : kind.entity,
            action: row.action,
            target: {
              id: String(row.task_id ?? row.project_id),
              label,
              url: entityUrl({ kind: 'project', id: row.project_id }),
            },
            detail: row.task_id ? (titles.get(row.project_id) ?? null) : null,
          });
        });
    },
  );
}
