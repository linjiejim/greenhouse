/**
 * Deployment-level kill switches for the trusted-execution convergence layer.
 *
 * These are deliberately separate from per-user feature flags: operators can
 * stop a derived read model or automation loop without changing user grants.
 * Every switch defaults on for backward-compatible rollout, while any non-empty
 * unrecognised value is treated as off (fail closed) and reported by the health
 * endpoint.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app-env.js';

export const TRUSTED_EXECUTION_SWITCH_ENV = {
  chatAdapter: 'RUNTIME_CHAT_ADAPTER_ENABLED',
  runtimeWorker: 'RUNTIME_WORKER_ENABLED',
  automationDriver: 'RUNTIME_AUTOMATION_DRIVER_ENABLED',
  notificationProjector: 'RUNTIME_NOTIFICATION_PROJECTOR_ENABLED',
  taskCenter: 'TASK_CENTER_ENABLED',
  approvalInbox: 'RUNTIME_APPROVAL_INBOX_ENABLED',
} as const;

export interface TrustedExecutionSwitches {
  chatAdapter: boolean;
  runtimeWorker: boolean;
  automationDriver: boolean;
  notificationProjector: boolean;
  taskCenter: boolean;
  approvalInbox: boolean;
  /** Environment variable names whose non-empty values were not recognised. */
  invalidEnv: string[];
}

export interface TrustedExecutionBootPlan {
  runtimeWorker: boolean;
  chatAdapter: boolean;
  automationDriver: boolean;
  notificationProjector: boolean;
  taskCenter: boolean;
  approvalInbox: boolean;
}

type Environment = Record<string, string | undefined>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function defaultOnSwitch(env: Environment, name: string, invalidEnv: string[]): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return true;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (!FALSE_VALUES.has(normalized)) invalidEnv.push(name);
  return false;
}

export function resolveTrustedExecutionSwitches(env: Environment = process.env): TrustedExecutionSwitches {
  const invalidEnv: string[] = [];
  return {
    chatAdapter: defaultOnSwitch(env, TRUSTED_EXECUTION_SWITCH_ENV.chatAdapter, invalidEnv),
    runtimeWorker: defaultOnSwitch(env, TRUSTED_EXECUTION_SWITCH_ENV.runtimeWorker, invalidEnv),
    automationDriver: defaultOnSwitch(env, TRUSTED_EXECUTION_SWITCH_ENV.automationDriver, invalidEnv),
    notificationProjector: defaultOnSwitch(env, TRUSTED_EXECUTION_SWITCH_ENV.notificationProjector, invalidEnv),
    taskCenter: defaultOnSwitch(env, TRUSTED_EXECUTION_SWITCH_ENV.taskCenter, invalidEnv),
    approvalInbox: defaultOnSwitch(env, TRUSTED_EXECUTION_SWITCH_ENV.approvalInbox, invalidEnv),
    invalidEnv,
  };
}

/** Effective services/surfaces after their explicit dependencies are applied. */
export function trustedExecutionBootPlan(switches: TrustedExecutionSwitches): TrustedExecutionBootPlan {
  return {
    runtimeWorker: switches.runtimeWorker,
    chatAdapter: switches.chatAdapter,
    automationDriver: switches.runtimeWorker && switches.automationDriver,
    notificationProjector: switches.runtimeWorker && switches.notificationProjector,
    taskCenter: switches.taskCenter,
    approvalInbox: switches.taskCenter && switches.approvalInbox,
  };
}

export function runtimeAdapterEnabled(
  kind: 'chat',
  switches: TrustedExecutionSwitches = resolveTrustedExecutionSwitches(),
): boolean {
  return kind === 'chat' && switches.chatAdapter;
}

type GuardedSurface = 'task-center' | 'approval-inbox';

const SURFACE_UNAVAILABLE = {
  'task-center': {
    error: 'Execution Center is unavailable in this environment',
    code: 'task_center_disabled',
  },
  'approval-inbox': {
    error: 'Approval Inbox is unavailable in this environment',
    code: 'approval_inbox_disabled',
  },
} as const;

/** Stable authenticated 503 instead of a dead route when a surface is killed. */
export function requireTrustedExecutionSurface(
  enabled: boolean | (() => boolean),
  surface: GuardedSurface,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(typeof enabled === 'function' ? enabled() : enabled)) {
      return c.json(SURFACE_UNAVAILABLE[surface], 503);
    }
    await next();
  };
}

/** Public-safe health facts: switch state and variable names only, never values. */
export function trustedExecutionHealthView(switches: TrustedExecutionSwitches) {
  const effective = trustedExecutionBootPlan(switches);
  return {
    adapters: {
      chat: effective.chatAdapter,
    },
    services: {
      runtime_worker: effective.runtimeWorker,
      automation_driver: effective.automationDriver,
      notification_projector: effective.notificationProjector,
      notification_delivery: effective.notificationProjector,
    },
    surfaces: {
      task_center: effective.taskCenter,
      approval_inbox: effective.approvalInbox,
    },
    invalid_env: switches.invalidEnv,
  };
}
