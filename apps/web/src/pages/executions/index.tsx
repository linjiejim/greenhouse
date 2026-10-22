import { EXECUTIONS_ROOT_HASH } from '../../lib/execution-route';
import { parseExecutionSubPath } from './model';
import { TaskCenter } from './task-center';
import { TaskRunDetail } from './task-detail';

export function ExecutionsPage({ subPath, params }: { subPath: string; params: URLSearchParams }) {
  const { runId } = parseExecutionSubPath(subPath);
  // Historical Mission runs (retired in v1.4) open in the generic Runtime detail.
  if (runId) return <TaskRunDetail runId={runId} backHref={EXECUTIONS_ROOT_HASH} />;
  const requestedKind = params.get('kind');
  const requestedTab = params.get('tab');
  return (
    <TaskCenter
      initialKind={
        requestedKind === 'automation' || requestedKind === 'subagent' || requestedKind === 'agent_write'
          ? requestedKind
          : 'all'
      }
      initialTab={
        requestedTab === 'attention' ||
        requestedTab === 'active' ||
        requestedTab === 'completed' ||
        requestedTab === 'failed' ||
        requestedTab === 'all'
          ? requestedTab
          : 'active'
      }
    />
  );
}

export { TaskCenter } from './task-center';
export { TaskRunDetail } from './task-detail';
