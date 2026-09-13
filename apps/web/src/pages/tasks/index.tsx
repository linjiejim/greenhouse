import { EXECUTIONS_ROOT_HASH, executionRunHref, missionSourceRunId } from '../../lib/execution-route';
import { CloudAgentRunDetail } from '../cloud-agent/run-detail';
import { parseExecutionSubPath } from './model';
import { TaskCenter } from './task-center';
import { TaskRunDetail } from './task-detail';

export function ExecutionsPage({ subPath, params }: { subPath: string; params: URLSearchParams }) {
  const { kind, runId } = parseExecutionSubPath(subPath);
  if (kind === 'mission' && runId && params.get('view') !== 'runtime') {
    const canonicalHref = executionRunHref({ kind, id: runId });
    return (
      <CloudAgentRunDetail
        runId={missionSourceRunId(runId)}
        backHref={EXECUTIONS_ROOT_HASH}
        runtimeDetailsHref={`${canonicalHref}?view=runtime`}
      />
    );
  }
  if (runId) {
    const backHref = kind === 'mission' ? executionRunHref({ kind, id: runId }) : EXECUTIONS_ROOT_HASH;
    return <TaskRunDetail runId={runId} backHref={backHref} />;
  }
  const requestedKind = params.get('kind');
  const requestedTab = params.get('tab');
  return (
    <TaskCenter
      initialKind={
        requestedKind === 'mission' ||
        requestedKind === 'workflow' ||
        requestedKind === 'automation' ||
        requestedKind === 'subagent'
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
