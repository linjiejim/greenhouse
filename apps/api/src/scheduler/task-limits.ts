/**
 * Automation limits — the numbers task-center enforces and the automation tools
 * quote to the model, in one place.
 *
 * This file is deliberately a LEAF: it imports nothing. The tool modules read
 * these at module-evaluation time (they are interpolated into the tool
 * description), and the tool catalog sits on an import cycle —
 * registry → agent → scheduler → task-center → back to the tool files. Keeping
 * the constants in task-center.ts meant they were still in the temporal dead
 * zone when the tool module body ran, and the API died at boot with
 * "Cannot access 'MIN_PROMPT_LENGTH' before initialization". Unit tests do not
 * catch it — they enter the graph from the tool file, not from the app entry.
 *
 * So: no imports here, ever. Anything that needs a dependency belongs in
 * task-center.ts instead.
 */

export const MAX_TASKS_PER_USER = 10;
export const MAX_PROMPT_LENGTH = 4000;
export const MIN_PROMPT_LENGTH = 10;
export const MAX_STEPS_LIMIT = 20;
export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 50;
export const DEFAULT_TIMEZONE = 'UTC';
/** Cron floor: nothing may fire more often than once an hour. */
export const MIN_INTERVAL_MS = 3600_000;

/**
 * Which group-bot family a (write-time validated) notify_webhook URL belongs
 * to. Lives in this leaf on purpose: notify.ts consumes it, and importing
 * task-center from notify would close the cycle
 * notify → task-center → scheduler/index → notify.
 */
export function notifyWebhookKind(webhook: string): 'wecom' | 'feishu' {
  try {
    return new URL(webhook).hostname === 'open.feishu.cn' ? 'feishu' : 'wecom';
  } catch {
    return 'wecom';
  }
}
