/**
 * Scheduled-task result delivery.
 *
 * Without this a task run only leaves a silent session in the sidebar — the
 * known gap called out in the automation spec. A run that fires at 03:00 is
 * worth nothing if nobody learns it happened.
 *
 * Delivery is a SCHEDULER behaviour, deliberately not an agent tool: the agent
 * produces the content, the system decides where it goes. Handing the model a
 * "post to this URL" or "send to this address" tool would be an outbound
 * channel it could aim anywhere. Both channels here are aimed by construction:
 *   • WeCom  — the webhook is validated as a qyapi.weixin.qq.com endpoint at
 *              write time (task-center.validateNotifyWebhook).
 *   • Email  — `notify_email` is a BOOLEAN. The recipient is looked up from the
 *              task owner, so there is no address for anyone to supply.
 *   • WeCom DM — `notify_wecom` is a BOOLEAN too. `touser` comes from the
 *              owner's stored WeCom binding, so the same property holds: there
 *              is no recipient field for anyone to point elsewhere.
 *
 * The scheduler never sends from the Runtime outbox callback. It first writes
 * one permanent in-app notification plus an idempotent delivery row per
 * enabled channel. The delivery worker owns network I/O, leases, retries and
 * dead-lettering, so a process crash cannot create the old "run succeeded but
 * nobody will ever be notified" window.
 */

import { logger } from '@greenhouse/utils/logger';
import type { DatabaseProvider, ScheduledTaskRow } from '@greenhouse/db';
import { flattenRichOutput, renderNotificationEmail } from '../notifications/render.js';
import { notifyWebhookKind } from './task-limits.js';
import { connectionManager } from '../ws/connection-manager.js';

/** Keep the card readable in a group chat; the session link carries the rest. */
const MAX_SUMMARY_CHARS = 600;

/**
 * Email is the channel people read end to end, so it carries the whole answer —
 * the 600-char card limit was cutting tables off mid-row. Still bounded: an agent
 * that loops can emit megabytes, and nobody wants that in their inbox.
 */
const MAX_EMAIL_BODY_CHARS = 20_000;

function truncate(text: string, limit = MAX_SUMMARY_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * What a delivery channel should show for a run.
 *
 * The summary is the assistant's final message, written for the chat renderer, so
 * it has to be flattened before it goes anywhere else — see
 * `notifications/render.ts`. The raw text stays in the notification payload; only
 * the presentation is decided here.
 */
function deliveryBody(summary: string, limit = MAX_SUMMARY_CHARS): string {
  return truncate(flattenRichOutput(summary), limit) || '(no output)';
}

export interface TaskNotification {
  status: 'completed' | 'failed';
  /** The assistant's answer (completed) or the error message (failed). */
  summary: string;
  sessionId: string;
}

/** Keep the write list from swallowing the answer it is appended to. */
const MAX_LISTED_WRITES = 20;

/**
 * The price of granting an automation a write tool (spec D7).
 *
 * The owner gave up per-call confirmation at configuration time, so the one
 * thing they must not lose is finding out promptly WHAT was written. The source
 * is Runtime ToolCall evidence — written at the real `execute` boundary — and
 * not a re-parse of `messages.pipeline`, which is a reconstruction after the
 * fact.
 *
 * `risk_level !== 'r0'` is the "this was a write" test: risk is derived from
 * each tool's proxy read/write posture in `defineTool`, so the section stays
 * correct as tools are added without a second list to maintain here.
 *
 * Returns '' on any failure. A successful run must never be reported as failed
 * (or held up) because its receipt could not be rendered.
 */
async function collectWrites(db: DatabaseProvider, runId: string | undefined): Promise<AutomationWriteRecord[]> {
  if (!runId) return [];
  try {
    const calls = await db.runtime.listToolCalls(runId);
    return calls
      .filter((call) => call.risk_level !== 'r0' && call.status !== 'pending')
      .map((call) => ({
        tool: call.tool_name,
        ...(actionOf(call.input) ? { action: actionOf(call.input)! } : {}),
        status: call.status,
      }));
  } catch (error) {
    logger.warn('[Scheduler] Could not collect automation write receipt', { runId, error: String(error) });
    return [];
  }
}

/**
 * Render the receipt for a delivery body. Pure, and shared by every channel —
 * the payload stores the facts, this decides how they look.
 */
export function formatWriteReceipt(writes: readonly AutomationWriteRecord[] | undefined): string {
  if (!writes || writes.length === 0) return '';
  const lines = writes.slice(0, MAX_LISTED_WRITES).map((write) => {
    const action = write.action ? ` (${write.action})` : '';
    const status = write.status && write.status !== 'succeeded' ? ` · ${write.status}` : '';
    return `- ${write.tool}${action}${status}`;
  });
  const omitted = writes.length - lines.length;
  if (omitted > 0) lines.push(`- …还有 ${omitted} 次未列出`);
  return `\n\n**本次写入**\n${lines.join('\n')}`;
}

/** Most mutation tools dispatch on a top-level `action`; show it when present. */
function actionOf(rawInput: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const action = (parsed as { action?: unknown }).action;
      if (typeof action === 'string' && action) return action;
    }
  } catch {
    // Not our problem here — the full input is permanently in the ToolCall row.
  }
  return null;
}

/**
 * One non-read tool call the run made. Facts only — how it is shown is
 * `formatWriteReceipt`'s job, so restyling the receipt never becomes a data
 * migration (same rule that keeps `summary` raw in here).
 */
export interface AutomationWriteRecord {
  tool: string;
  action?: string;
  status?: string;
}

export interface AutomationResultNotificationPayload {
  schema: 1;
  type: 'automation_result';
  task_id: number;
  task_name: string;
  session_id: string;
  status: TaskNotification['status'];
  summary: string;
  runtime_kind?: 'automation';
  runtime_run_id?: string;
  /** Present only when the run actually wrote something (spec D7). */
  writes?: AutomationWriteRecord[];
}

export interface TaskNotificationProvenance {
  runId?: string;
  eventId?: string;
}

const EMAIL_USER_PREFIX = 'email:user:';
const WECOM_USER_PREFIX = 'wecom:user:';
const WECOM_WEBHOOK_PREFIX = 'wecom:webhook:';
const FEISHU_USER_PREFIX = 'feishu:user:';
const FEISHU_WEBHOOK_PREFIX = 'feishu:webhook:';

export const automationDeliveryRecipient = {
  emailUser(userId: string): string {
    return `${EMAIL_USER_PREFIX}${userId}`;
  },
  wecomUser(userId: string): string {
    return `${WECOM_USER_PREFIX}${userId}`;
  },
  wecomWebhook(webhook: string): string {
    return `${WECOM_WEBHOOK_PREFIX}${webhook}`;
  },
  feishuUser(userId: string): string {
    return `${FEISHU_USER_PREFIX}${userId}`;
  },
  feishuWebhook(webhook: string): string {
    return `${FEISHU_WEBHOOK_PREFIX}${webhook}`;
  },
  parse(
    value: string,
  ):
    | { kind: 'email_user'; userId: string }
    | { kind: 'wecom_user'; userId: string }
    | { kind: 'wecom_webhook'; webhook: string }
    | { kind: 'feishu_user'; userId: string }
    | { kind: 'feishu_webhook'; webhook: string }
    | null {
    if (value.startsWith(EMAIL_USER_PREFIX) && value.length > EMAIL_USER_PREFIX.length) {
      return { kind: 'email_user', userId: value.slice(EMAIL_USER_PREFIX.length) };
    }
    if (value.startsWith(WECOM_USER_PREFIX) && value.length > WECOM_USER_PREFIX.length) {
      return { kind: 'wecom_user', userId: value.slice(WECOM_USER_PREFIX.length) };
    }
    if (value.startsWith(WECOM_WEBHOOK_PREFIX) && value.length > WECOM_WEBHOOK_PREFIX.length) {
      return { kind: 'wecom_webhook', webhook: value.slice(WECOM_WEBHOOK_PREFIX.length) };
    }
    if (value.startsWith(FEISHU_USER_PREFIX) && value.length > FEISHU_USER_PREFIX.length) {
      return { kind: 'feishu_user', userId: value.slice(FEISHU_USER_PREFIX.length) };
    }
    if (value.startsWith(FEISHU_WEBHOOK_PREFIX) && value.length > FEISHU_WEBHOOK_PREFIX.length) {
      return { kind: 'feishu_webhook', webhook: value.slice(FEISHU_WEBHOOK_PREFIX.length) };
    }
    return null;
  },
};

export function parseAutomationResultNotificationPayload(value: unknown): AutomationResultNotificationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Partial<AutomationResultNotificationPayload>;
  if (
    payload.schema !== 1 ||
    payload.type !== 'automation_result' ||
    !Number.isSafeInteger(payload.task_id) ||
    Number(payload.task_id) <= 0 ||
    typeof payload.task_name !== 'string' ||
    !payload.task_name.trim() ||
    typeof payload.session_id !== 'string' ||
    !payload.session_id.trim() ||
    (payload.status !== 'completed' && payload.status !== 'failed') ||
    typeof payload.summary !== 'string'
  ) {
    return null;
  }
  const writes = Array.isArray(payload.writes)
    ? payload.writes.filter(
        (entry): entry is AutomationWriteRecord =>
          !!entry && typeof entry === 'object' && typeof (entry as AutomationWriteRecord).tool === 'string',
      )
    : [];
  // A malformed receipt must not cost the reader the answer it was appended to,
  // so bad entries are dropped instead of rejecting the whole payload.
  return { ...(payload as AutomationResultNotificationPayload), ...(writes.length ? { writes } : {}) };
}

/**
 * The session lives at `#/chat?session=<id>`, NOT `#/chat/<id>`.
 *
 * The hash router reads the session from the query string; a path segment after
 * `#/chat` is simply ignored, so the old form opened an empty new conversation
 * and the run people were notified about was nowhere to be seen. A link that
 * lands on the wrong screen is worse than no link, because nobody suspects it.
 */
function sessionLink(sessionId: string): string | null {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  return base ? `${base}/#/chat?session=${encodeURIComponent(sessionId)}` : null;
}

export function buildTaskNotification(
  task: Pick<ScheduledTaskRow, 'name'>,
  outcome: TaskNotification,
  writes?: readonly AutomationWriteRecord[],
): string {
  const heading = outcome.status === 'completed' ? `✅ ${task.name}` : `⚠️ ${task.name}`;
  const url = sessionLink(outcome.sessionId);
  const link = url ? `\n\n[打开会话](${url})` : '';
  // The receipt is appended AFTER truncation: it is the one part the owner
  // cannot reconstruct from the conversation title, so a long answer must not
  // push it out.
  return `**${heading}**\n\n${deliveryBody(outcome.summary)}${formatWriteReceipt(writes)}${link}`;
}

/** Plain-text and HTML bodies for the email channel. */
export function buildTaskEmail(
  task: Pick<ScheduledTaskRow, 'name'>,
  outcome: TaskNotification,
  writes?: readonly AutomationWriteRecord[],
): { subject: string; body_text: string; body_html: string } {
  const mark = outcome.status === 'completed' ? '✅' : '⚠️';
  const heading = `${mark} ${task.name}`;
  const body = `${deliveryBody(outcome.summary, MAX_EMAIL_BODY_CHARS)}${formatWriteReceipt(writes)}`;
  const url = sessionLink(outcome.sessionId);

  return {
    subject: heading,
    body_text: [heading, '', body, ...(url ? ['', `打开会话：${url}`] : [])].join('\n'),
    body_html: renderNotificationEmail({
      heading,
      body,
      link: url ? { url, label: '打开会话' } : null,
    }),
  };
}

/** Persist the notification fact and every enabled optional delivery. */
export async function notifyTaskResult(
  db: DatabaseProvider,
  task: ScheduledTaskRow,
  outcome: TaskNotification,
  provenance: TaskNotificationProvenance = {},
): Promise<{ wecom: boolean; email: boolean; wecomDm: boolean; feishuDm: boolean }> {
  const writes = await collectWrites(db, provenance.runId);
  const payload: AutomationResultNotificationPayload = {
    schema: 1,
    type: 'automation_result',
    task_id: task.id,
    task_name: task.name,
    session_id: outcome.sessionId,
    status: outcome.status,
    summary: outcome.summary,
    ...(provenance.runId ? { runtime_kind: 'automation', runtime_run_id: provenance.runId } : {}),
    ...(writes.length ? { writes } : {}),
  };
  const failed = outcome.status === 'failed';
  const result = await db.notifications.createWithStatus({
    user_id: task.user_id,
    kind: failed ? 'runtime_failed' : 'runtime_completed',
    title: failed ? `${task.name} needs review` : `${task.name} completed`,
    body: `${deliveryBody(outcome.summary)}${formatWriteReceipt(writes)}`,
    payload,
    run_id: provenance.runId ?? null,
    event_id: provenance.eventId ?? null,
    dedupe_key: provenance.runId
      ? `automation-result:${provenance.runId}:${outcome.status}`
      : `automation-result:${task.id}:${outcome.sessionId}:${outcome.status}`,
  });
  const queued = { wecom: false, email: false, wecomDm: false, feishuDm: false };

  if (task.notify_webhook) {
    // The webhook family is derived from the (write-time validated) URL host,
    // so one field serves both group-bot flavours without a second column.
    const feishu = notifyWebhookKind(task.notify_webhook) === 'feishu';
    await db.notifications.createDelivery({
      notification_id: result.notification.id,
      channel: feishu ? 'feishu' : 'wecom',
      recipient: feishu
        ? automationDeliveryRecipient.feishuWebhook(task.notify_webhook)
        : automationDeliveryRecipient.wecomWebhook(task.notify_webhook),
    });
    queued.wecom = true;
  }

  if (task.notify_email) {
    await db.notifications.createDelivery({
      notification_id: result.notification.id,
      channel: 'email',
      recipient: automationDeliveryRecipient.emailUser(task.user_id),
    });
    queued.email = true;
  }

  if (task.notify_wecom) {
    await db.notifications.createDelivery({
      notification_id: result.notification.id,
      channel: 'wecom',
      recipient: automationDeliveryRecipient.wecomUser(task.user_id),
    });
    queued.wecomDm = true;
  }

  if (task.notify_feishu) {
    await db.notifications.createDelivery({
      notification_id: result.notification.id,
      channel: 'feishu',
      recipient: automationDeliveryRecipient.feishuUser(task.user_id),
    });
    queued.feishuDm = true;
  }

  if (result.created) {
    try {
      const unread = await db.notifications.countUnread(task.user_id);
      connectionManager.sendToUser(task.user_id, {
        type: 'notification:new',
        notificationId: result.notification.id,
        kind: result.notification.kind,
        title: result.notification.title,
        unread,
        runId: null,
        interruptId: null,
      });
    } catch (error) {
      // The permanent row is authoritative. A transient WS failure must not
      // replay an already-created external delivery.
      logger.warn('[Scheduler] Could not push automation notification summary', {
        taskId: task.id,
        notificationId: result.notification.id,
        error: String(error),
      });
    }
  }

  return queued;
}
