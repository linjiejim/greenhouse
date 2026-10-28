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
      RUNTIME_APPROVAL_INBOX_ENABLED: 'tru',
    });
    expect(switches).toMatchObject({
      chatAdapter: true,
      runtimeWorker: false,
      automationDriver: false,
      notificationProjector: false,
      approvalInbox: false,
      invalidEnv: ['RUNTIME_NOTIFICATION_PROJECTOR_ENABLED', 'RUNTIME_APPROVAL_INBOX_ENABLED'],
    });
  });

  it('derives boot dependencies without widening configured switches', () => {
    const switches = resolveTrustedExecutionSwitches({
      RUNTIME_CHAT_ADAPTER_ENABLED: '0',
      RUNTIME_WORKER_ENABLED: '0',
      RUNTIME_AUTOMATION_DRIVER_ENABLED: '1',
      RUNTIME_NOTIFICATION_PROJECTOR_ENABLED: '1',
      RUNTIME_APPROVAL_INBOX_ENABLED: '0',
    });
    expect(trustedExecutionBootPlan(switches)).toEqual({
      runtimeWorker: false,
      chatAdapter: false,
      automationDriver: false,
      notificationProjector: false,
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
      surfaces: { approval_inbox: false },
      invalid_env: [],
    });
  });

  it('returns a stable 503 when a killed surface is requested', async () => {
    const app = new Hono<AppEnv>()
      .use('/interrupts/*', requireTrustedExecutionSurface(false, 'approval-inbox'))
      .get('/interrupts/list', (c) => c.json({ ok: true }));

    const response = await app.request('/interrupts/list');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Approval Inbox is unavailable in this environment',
      code: 'approval_inbox_disabled',
    });
  });

  it('passes through when the surface is enabled', async () => {
    const app = new Hono<AppEnv>()
      .use('/interrupts/*', requireTrustedExecutionSurface(true, 'approval-inbox'))
      .get('/interrupts/list', (c) => c.json({ ok: true }));

    const response = await app.request('/interrupts/list');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
