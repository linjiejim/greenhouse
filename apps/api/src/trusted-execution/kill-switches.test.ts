import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../app-env.js';
import {
  requireTrustedExecutionSurface,
  resolveTrustedExecutionSwitches,
  runtimeAdapterEnabled,
  runtimeDriverEnabled,
  trustedExecutionBootPlan,
  trustedExecutionHealthView,
} from './kill-switches.js';

describe('trusted-execution kill switches', () => {
  it('defaults every convergence capability on', () => {
    const switches = resolveTrustedExecutionSwitches({});
    expect(switches).toEqual({
      missionAdapter: true,
      workflowAdapter: true,
      chatAdapter: true,
      runtimeWorker: true,
      evalDriver: true,
      automationDriver: true,
      subagentDriver: true,
      notificationProjector: true,
      taskCenter: true,
      approvalInbox: true,
      agentGovernance: true,
      invalidEnv: [],
    });
    expect(runtimeAdapterEnabled('mission', switches)).toBe(true);
    expect(runtimeAdapterEnabled('workflow', switches)).toBe(true);
    expect(runtimeAdapterEnabled('chat', switches)).toBe(true);
    expect(runtimeDriverEnabled('eval', switches)).toBe(true);
    expect(runtimeDriverEnabled('automation', switches)).toBe(true);
    expect(runtimeDriverEnabled('subagent', switches)).toBe(true);
  });

  it('accepts explicit booleans and fails closed on a typo', () => {
    const switches = resolveTrustedExecutionSwitches({
      RUNTIME_MISSION_ADAPTER_ENABLED: '0',
      RUNTIME_WORKFLOW_ADAPTER_ENABLED: 'off',
      RUNTIME_CHAT_ADAPTER_ENABLED: 'yes',
      RUNTIME_WORKER_ENABLED: 'FALSE',
      RUNTIME_EVAL_DRIVER_ENABLED: '1',
      RUNTIME_AUTOMATION_DRIVER_ENABLED: 'no',
      RUNTIME_SUBAGENT_DRIVER_ENABLED: 'bad-value',
      RUNTIME_NOTIFICATION_PROJECTOR_ENABLED: 'yes',
      TASK_CENTER_ENABLED: 'tru',
      RUNTIME_APPROVAL_INBOX_ENABLED: '1',
      AGENT_GOVERNANCE_ENABLED: 'no',
    });
    expect(switches).toMatchObject({
      missionAdapter: false,
      workflowAdapter: false,
      chatAdapter: true,
      runtimeWorker: false,
      evalDriver: true,
      automationDriver: false,
      subagentDriver: false,
      notificationProjector: true,
      taskCenter: false,
      approvalInbox: true,
      agentGovernance: false,
      invalidEnv: ['RUNTIME_SUBAGENT_DRIVER_ENABLED', 'TASK_CENTER_ENABLED'],
    });
  });

  it('derives boot dependencies without widening configured switches', () => {
    const switches = resolveTrustedExecutionSwitches({
      RUNTIME_MISSION_ADAPTER_ENABLED: '0',
      RUNTIME_WORKFLOW_ADAPTER_ENABLED: '0',
      RUNTIME_CHAT_ADAPTER_ENABLED: '0',
      RUNTIME_WORKER_ENABLED: '0',
      RUNTIME_EVAL_DRIVER_ENABLED: '1',
      RUNTIME_AUTOMATION_DRIVER_ENABLED: '1',
      RUNTIME_SUBAGENT_DRIVER_ENABLED: '1',
      RUNTIME_NOTIFICATION_PROJECTOR_ENABLED: '1',
      TASK_CENTER_ENABLED: '0',
      RUNTIME_APPROVAL_INBOX_ENABLED: '1',
    });
    expect(trustedExecutionBootPlan(switches)).toEqual({
      runtimeReconciler: false,
      runtimeWorker: false,
      chatAdapter: false,
      evalDriver: false,
      automationDriver: false,
      subagentDriver: false,
      notificationProjector: false,
      taskCenter: false,
      approvalInbox: false,
      agentGovernance: true,
    });
    expect(trustedExecutionHealthView(switches)).toEqual({
      adapters: { mission: false, workflow: false, chat: false },
      services: {
        runtime_worker: false,
        eval_driver: false,
        automation_driver: false,
        subagent_driver: false,
        notification_projector: false,
        notification_delivery: false,
        agent_governance: true,
      },
      surfaces: { task_center: false, approval_inbox: false },
      invalid_env: [],
    });
  });

  it('returns a stable 503 when a killed surface is requested', async () => {
    const app = new Hono<AppEnv>()
      .use('/tasks/*', requireTrustedExecutionSurface(false, 'task-center'))
      .get('/tasks/list', (c) => c.json({ ok: true }));

    const response = await app.request('/tasks/list');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Execution Center is unavailable in this environment',
      code: 'task_center_disabled',
    });
  });

  it('passes through when the surface is enabled', async () => {
    const app = new Hono<AppEnv>()
      .use('/tasks/*', requireTrustedExecutionSurface(true, 'task-center'))
      .get('/tasks/list', (c) => c.json({ ok: true }));

    const response = await app.request('/tasks/list');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
