import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_ROOT_HASH,
  executionNotificationHref,
  executionRunHref,
  legacyExecutionRedirect,
  missionExecutionHref,
  parseExecutionSubPath,
} from './execution-route.js';

describe('Activity log and run detail routes', () => {
  it('builds canonical list and detail URLs', () => {
    expect(ACTIVITY_ROOT_HASH).toBe('#/activity');
    expect(executionRunHref({ kind: 'workflow', id: 'run/42' })).toBe('#/activity/workflow/run%2F42');
    expect(missionExecutionHref('car_42')).toBe('#/activity/mission/rtm_car_42');
  });

  it('parses canonical kind/id detail routes', () => {
    expect(parseExecutionSubPath('mission/run%2F42')).toEqual({ kind: 'mission', runId: 'run/42' });
    expect(parseExecutionSubPath('')).toEqual({ kind: null, runId: null });
  });

  it('builds notification deep links from the Runtime kind', () => {
    expect(executionNotificationHref('run/42', { runtime_kind: 'workflow' })).toBe('#/activity/workflow/run%2F42');
    expect(executionNotificationHref('old/run', {})).toBe('#/activity/old%2Frun');
  });

  it('redirects every retired execution route and preserves query parameters', () => {
    expect(legacyExecutionRedirect('#/task-center/mission/rtm_car_42?view=runtime')).toBe(
      '#/activity/mission/rtm_car_42?view=runtime',
    );
    expect(legacyExecutionRedirect('#/tasks/workflow/run-1')).toBe('#/activity/workflow/run-1');
    expect(legacyExecutionRedirect('#/missions')).toBe('#/activity?kind=mission');
    expect(legacyExecutionRedirect('#/missions/car_42?tab=artifacts')).toBe(
      '#/activity/mission/rtm_car_42?tab=artifacts',
    );
    expect(legacyExecutionRedirect('#/cloud-agent/runs/car_42')).toBe('#/activity/mission/rtm_car_42');
    expect(legacyExecutionRedirect('#/activity')).toBeNull();
    // v1.5: the Execution Center became the Activity log.
    expect(legacyExecutionRedirect('#/executions')).toBe('#/activity');
    expect(legacyExecutionRedirect('#/executions/automation/rtr_1?tab=attention')).toBe(
      '#/activity/automation/rtr_1?tab=attention',
    );
  });
});

describe('agent write notifications', () => {
  it('open Activity in Settings › Agent connections, not the Execution center', () => {
    expect(executionNotificationHref('rtr_1', { runtime_kind: 'agent_write' })).toBe(
      '#/settings/agent-connections/activity',
    );
  });
});
