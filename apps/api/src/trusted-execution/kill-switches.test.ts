import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../app-env.js';
import {
  requireTrustedExecutionSurface,
  resolveTrustedExecutionSwitches,
  runtimeAdapterEnabled,
  trustedExecutionBootPlan,
  trustedExecutionHealthView,
} from './kill-switches.js';

describe('trusted-execution kill switches', () => {
  it('defaults every convergence capability on', () => {
    const switches = resolveTrustedExecutionSwitches({});
    expect(switches).toEqual({
      chatAdapter: true,
      runtimeWorker: true,
      automationDriver: true,
      notificationProjector: true,
      taskCenter: true,
      approvalInbox: true,
      invalidEnv: [],
    });
    expect(runtimeAdapterEnabled('chat', switches)).toBe(true);
  });

  it('accepts explicit booleans and fails closed on a typo', () => {
    const switches = resolveTrustedExecutionSwitches({
      RUNTIME_CHAT_ADAPTER_ENABLED: 'yes',
      RUNTIME_WORKER_ENABLED: 'FALSE',
      RUNTIME_AUTOMATION_DRIVER_ENABLED: 'no',
      RUNTIME_NOTIFICATION_PROJECTOR_ENABLED: 'bad-value',
      TASK_CENTER_ENABLED: 'tru',
      RUNTIME_APPROVAL_INBOX_ENABLED: '1',
    });
    expect(switches).toMatchObject({
      chatAdapter: true,
      runtimeWorker: false,
      automationDriver: false,
      notificationProjector: false,
      taskCenter: false,
      approvalInbox: true,
      invalidEnv: ['RUNTIME_NOTIFICATION_PROJECTOR_ENABLED', 'TASK_CENTER_ENABLED'],
    });
  });

  it('derives boot dependencies without widening configured switches', () => {
    const switches = resolveTrustedExecutionSwitches({
      RUNTIME_CHAT_ADAPTER_ENABLED: '0',
      RUNTIME_WORKER_ENABLED: '0',
      RUNTIME_AUTOMATION_DRIVER_ENABLED: '1',
      RUNTIME_NOTIFICATION_PROJECTOR_ENABLED: '1',
      TASK_CENTER_ENABLED: '0',
      RUNTIME_APPROVAL_INBOX_ENABLED: '1',
    });
    expect(trustedExecutionBootPlan(switches)).toEqual({
      runtimeWorker: false,
      chatAdapter: false,
      automationDriver: false,
      notificationProjector: false,
      taskCenter: false,
      approvalInbox: false,
    });
    expect(trustedExecutionHealthView(switches)).toEqual({
      adapters: { chat: false },
      services: {
        runtime_worker: false,
        automation_driver: false,
        notification_projector: false,
        notification_delivery: false,
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
