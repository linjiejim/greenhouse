/** Automation task snapshots as stored in a Runtime run's input. */

import type { ScheduledTaskRow } from '@greenhouse/db';
import { toRowId } from '@greenhouse/utils/id';

/**
 * A task snapshot as stored in a run's input. Snapshots written by 1.x carry a
 * numeric id, the four flat notify_* fields and unattended_tools as JSON text;
 * they are read into the current row shape (ids keep their decimal value, so the
 * deterministic run / session ids derived from them do not change).
 */
export function normalizeSnapshotTask(raw: Record<string, unknown>): ScheduledTaskRow {
  const task = { ...raw } as Record<string, unknown>;
  const id = toRowId(task.id);
  if (id) task.id = id;
  if (!task.notify || typeof task.notify !== 'object') {
    task.notify = {
      webhook: typeof task.notify_webhook === 'string' && task.notify_webhook ? task.notify_webhook : null,
      email: task.notify_email === true,
      wecom: task.notify_wecom === true,
      feishu: task.notify_feishu === true,
    };
    delete task.notify_webhook;
    delete task.notify_email;
    delete task.notify_wecom;
    delete task.notify_feishu;
  }
  if (typeof task.unattended_tools === 'string') {
    try {
      const parsed: unknown = JSON.parse(task.unattended_tools);
      task.unattended_tools = Array.isArray(parsed) ? parsed : [];
    } catch {
      task.unattended_tools = [];
    }
  }
  return task as unknown as ScheduledTaskRow;
}
