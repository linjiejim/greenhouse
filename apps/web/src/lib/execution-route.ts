import type { RuntimeJsonValue, RuntimeRun, RuntimeRunKind } from '@greenhouse/types/runtime';

export const EXECUTIONS_ROOT_HASH = '#/executions';

export type ExecutionRouteKind = Exclude<RuntimeRunKind, 'chat'>;

export function isExecutionRouteKind(value: unknown): value is ExecutionRouteKind {
  return (
    value === 'mission' || value === 'workflow' || value === 'automation' || value === 'subagent' || value === 'eval'
  );
}

export function executionRunHref(run: Pick<RuntimeRun, 'id' | 'kind'>): string {
  return `${EXECUTIONS_ROOT_HASH}/${run.kind}/${encodeURIComponent(run.id)}`;
}

/** Mission Runtime ids are deterministic (`rtm_<agent_run id>`). */
export function missionExecutionHref(sourceRunId: string): string {
  return executionRunHref({ kind: 'mission', id: `rtm_${sourceRunId}` });
}

export function missionSourceRunId(runtimeRunId: string): string {
  return runtimeRunId.startsWith('rtm_') ? runtimeRunId.slice(4) : runtimeRunId;
}

export function parseExecutionSubPath(subPath: string): {
  kind: ExecutionRouteKind | null;
  runId: string | null;
} {
  const parts = subPath.split('/').filter(Boolean);
  if (parts.length === 0) return { kind: null, runId: null };
  const kind = isExecutionRouteKind(parts[0]) ? parts[0] : null;
  const encodedRunId = kind ? parts.slice(1).join('/') : parts.join('/');
  if (!encodedRunId) return { kind, runId: null };
  try {
    return { kind, runId: decodeURIComponent(encodedRunId) };
  } catch {
    return { kind: null, runId: null };
  }
}

export function executionNotificationHref(runId: string, payload: RuntimeJsonValue): string {
  const kind =
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    isExecutionRouteKind(payload.runtime_kind)
      ? payload.runtime_kind
      : null;
  return kind ? executionRunHref({ id: runId, kind }) : `${EXECUTIONS_ROOT_HASH}/${encodeURIComponent(runId)}`;
}

function decodeSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function withQuery(destination: string, query: string): string {
  return query ? `${destination}${destination.includes('?') ? '&' : '?'}${query}` : destination;
}

/**
 * Canonicalize every retired execution URL in one place. Internal API/env keys
 * keep their compatibility names; only user-facing hashes move.
 */
export function legacyExecutionRedirect(hash: string): string | null {
  const cleaned = hash.replace(/^#\/?/, '');
  const queryIndex = cleaned.indexOf('?');
  const path = queryIndex >= 0 ? cleaned.slice(0, queryIndex) : cleaned;
  const query = queryIndex >= 0 ? cleaned.slice(queryIndex + 1) : '';
  const segments = path.split('/').filter(Boolean);
  const root = segments[0];

  if (root === 'task-center') {
    const tail = segments.slice(1).join('/');
    return withQuery(`${EXECUTIONS_ROOT_HASH}${tail ? `/${tail}` : ''}`, query);
  }

  // Runtime details briefly lived below #/tasks before that URL returned to
  // personal Prompt Tasks.
  if (root === 'tasks' && isExecutionRouteKind(segments[1]) && segments[2]) {
    return withQuery(`${EXECUTIONS_ROOT_HASH}/${segments.slice(1).join('/')}`, query);
  }

  if (root !== 'missions' && root !== 'cloud-agent') return null;

  const sourceSegment =
    root === 'cloud-agent' && segments[1] === 'runs' ? segments[2] : segments.length > 1 ? segments[1] : undefined;
  const sourceRunId = decodeSegment(sourceSegment);
  if (sourceRunId) return withQuery(missionExecutionHref(sourceRunId), query);

  const params = new URLSearchParams(query);
  params.set('kind', 'mission');
  return `${EXECUTIONS_ROOT_HASH}?${params.toString()}`;
}
