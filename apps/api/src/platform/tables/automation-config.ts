/**
 * The deployment switch for Tables automations (docs/specs/20261011-tables-foundation.md §4).
 *
 * `TABLES_AUTOMATION_WORKER` defaults on. Off (or any unrecognised value — fail
 * closed, like the other deployment switches) means the worker claims nothing
 * and the minute sweep enqueues nothing: record writes still queue their rule
 * runs (the outbox is part of the write), and they run once the switch is back
 * on. It is a deployment switch, not a trusted-execution one, so it stays out of
 * `TrustedExecutionSwitches`. `/health` reports the state.
 */

import { defaultOnSwitch } from '../../trusted-execution/kill-switches.js';

export const TABLES_AUTOMATION_WORKER_ENV = 'TABLES_AUTOMATION_WORKER';

type Environment = Record<string, string | undefined>;

export function resolveTablesAutomationWorker(env: Environment = process.env): { enabled: boolean; invalid: boolean } {
  const invalid: string[] = [];
  const enabled = defaultOnSwitch(env, TABLES_AUTOMATION_WORKER_ENV, invalid);
  return { enabled, invalid: invalid.length > 0 };
}

export function tablesAutomationWorkerEnabled(env: Environment = process.env): boolean {
  return resolveTablesAutomationWorker(env).enabled;
}

/** Public health posture: on/off, and whether the value was unrecognised (then it is off). */
export function tablesAutomationHealthView(env: Environment = process.env): { enabled: boolean; invalid_env?: string } {
  const { enabled, invalid } = resolveTablesAutomationWorker(env);
  return invalid ? { enabled, invalid_env: TABLES_AUTOMATION_WORKER_ENV } : { enabled };
}
