import { describe, expect, it } from 'vitest';

import {
  EXECUTIONS_ROOT_HASH,
  executionNotificationHref,
  executionRunHref,
  legacyExecutionRedirect,
  missionExecutionHref,
  missionSourceRunId,
  parseExecutionSubPath,
} from './execution-route.js';

describe('Execution Center routes', () => {
  it('builds canonical list and detail URLs', () => {
    expect(EXECUTIONS_ROOT_HASH).toBe('#/executions');
    expect(executionRunHref({ kind: 'workflow', id: 'run/42' })).toBe('#/executions/workflow/run%2F42');
    expect(missionExecutionHref('car_42')).toBe('#/executions/mission/rtm_car_42');
    expect(missionSourceRunId('rtm_car_42')).toBe('car_42');
  });

  it('parses canonical kind/id detail routes', () => {
    expect(parseExecutionSubPath('mission/run%2F42')).toEqual({ kind: 'mission', runId: 'run/42' });
    expect(parseExecutionSubPath('')).toEqual({ kind: null, runId: null });
  });

  it('builds notification deep links from the Runtime kind', () => {
    expect(executionNotificationHref('run/42', { runtime_kind: 'workflow' })).toBe('#/executions/workflow/run%2F42');
    expect(executionNotificationHref('old/run', {})).toBe('#/executions/old%2Frun');
  });

  it('redirects every retired execution route and preserves query parameters', () => {
    expect(legacyExecutionRedirect('#/task-center/mission/rtm_car_42?view=runtime')).toBe(
      '#/executions/mission/rtm_car_42?view=runtime',
    );
    expect(legacyExecutionRedirect('#/tasks/workflow/run-1')).toBe('#/executions/workflow/run-1');
    expect(legacyExecutionRedirect('#/missions')).toBe('#/executions?kind=mission');
    expect(legacyExecutionRedirect('#/missions/car_42?tab=artifacts')).toBe(
      '#/executions/mission/rtm_car_42?tab=artifacts',
    );
    expect(legacyExecutionRedirect('#/cloud-agent/runs/car_42')).toBe('#/executions/mission/rtm_car_42');
    expect(legacyExecutionRedirect('#/executions')).toBeNull();
  });
});
