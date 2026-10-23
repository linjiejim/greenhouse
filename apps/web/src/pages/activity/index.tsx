import { ACTIVITY_ROOT_HASH } from '../../lib/execution-route';
import { parseExecutionSubPath } from '../executions/model';
import { TaskRunDetail } from '../executions/task-detail';
import { ActivityLogPage } from './activity-log';

/**
 * `#/activity` — the Activity log; `#/activity/<kind>/<run id>` — the detail of
 * the run behind an agent write or an automation (the Runtime detail the
 * Execution Center used to open; historical Mission runs open here too).
 */
export function ActivityPage({ subPath }: { subPath: string }) {
  const { runId } = parseExecutionSubPath(subPath);
  if (runId) return <TaskRunDetail runId={runId} backHref={ACTIVITY_ROOT_HASH} />;
  return <ActivityLogPage moduleId="workspace.activity" />;
}

export { ActivityLogPage } from './activity-log';
