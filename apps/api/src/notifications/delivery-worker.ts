/**
 * Durable optional-channel delivery for permanent platform notifications: the
 * automation channels (WeCom / Feishu / email) one attempt at a time, mobile
 * pushes as one batch per pass (push/deliver.ts — Expo takes ≤100 per request).
 *
 * Two payload shapes reach the WeCom / Feishu / email channels: a scheduled
 * task's `automation_result`, and the generic `message` ({title, markdown,
 * href?}) that Tables automations write. A recipient who has not connected the
 * channel (no WeCom / Feishu binding, no email address) is settled
 * `suppressed` — rechecked and not worth sending — never retried to dead letter.
 */

import { randomUUID } from 'node:crypto';

import type { DatabaseProvider, NotificationDeliveryAttemptRow, NotificationDeliveryChannel } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { sendWeComMarkdown } from '@greenhouse/utils/wecom';
import { sendFeishuMarkdown } from '@greenhouse/utils/feishu';

import { botsLocale } from '../bots/engine/copy.js';
import { sendFromSharedMailbox } from '../email/service.js';
import { WECOM_PROVIDER } from '../routes/wecom-oauth.js';
import {
  automationDeliveryRecipient,
  buildTaskEmail,
  buildTaskNotification,
  parseAutomationResultNotificationPayload,
} from '../scheduler/notify.js';
import { sendAppMarkdown } from '../wecom/client.js';
import { sendCardMarkdown } from '../feishu/client.js';
import { FEISHU_PROVIDER } from '../routes/feishu-oauth.js';
import { deliverPushAttempts } from './push/deliver.js';
import type { FetchLike } from './push/expo.js';
import { flattenForDelivery, renderNotificationEmail } from './render.js';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_BATCH_SIZE = 20;

/** The automation result channels (the Runtime notification projector's half). */
export const AUTOMATION_DELIVERY_CHANNELS: readonly NotificationDeliveryChannel[] = ['wecom', 'feishu', 'email'];

interface DeliveryResult {
  ok: boolean;
  error?: string;
  /** Rechecked and not worth sending (the recipient has no binding / address): settle `suppressed`, no retry. */
  suppressed?: string;
}

/** The generic delivery payload (Tables automations): a title, Markdown, and an in-app `#/` link. */
export interface MessageNotificationPayload {
  schema: 1;
  type: 'message';
  title: string;
  markdown: string;
  href?: string;
}

export function parseMessageNotificationPayload(value: unknown): MessageNotificationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Partial<MessageNotificationPayload>;
  if (
    payload.schema !== 1 ||
    payload.type !== 'message' ||
    typeof payload.title !== 'string' ||
    !payload.title.trim() ||
    typeof payload.markdown !== 'string'
  ) {
    return null;
  }
  const href = typeof payload.href === 'string' && payload.href.startsWith('#/') ? payload.href : undefined;
  return { schema: 1, type: 'message', title: payload.title, markdown: payload.markdown, ...(href ? { href } : {}) };
}

/** An absolute link for a `#/` route, when the deployment knows its public URL. */
function absoluteLink(href: string | undefined): string | null {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  return href && base ? `${base}/${href}` : null;
}

const OPEN_LABEL = { en: 'Open', zh: '打开' } as const;

function messageMarkdown(message: MessageNotificationPayload, link: string | null, label: string): string {
  const body = flattenForDelivery(message.markdown).trim();
  return `**${message.title}**${body ? `\n\n${body}` : ''}${link ? `\n\n[${label}](${link})` : ''}`;
}

export interface NotificationDeliveryWorkerOptions {
  db: DatabaseProvider;
  workerId?: string;
  intervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  skipBootPass?: boolean;
  /**
   * The channels this worker claims (default: the automation channels). The API adds
   * `mobile_push` when `MOBILE_PUSH_ENABLED` is on — never claimed otherwise, so a
   * deployment with pushes off sends nothing to exp.host.
   */
  channels?: readonly NotificationDeliveryChannel[];
  /** Test seam for deterministic backoff timestamps. */
  now?: () => Date;
  /** Test seam for the Expo HTTP client. */
  pushFetch?: FetchLike;
}

export interface NotificationDeliveryWorker {
  runOnce(): Promise<void>;
  stop(): void;
}

export function retryAt(attempts: number, now: Date): string {
  const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
  return new Date(now.getTime() + delayMs).toISOString();
}

/**
 * The member-owned channels (DM / own email) share one shape: the envelope
 * names the notification's owner, and the binding is resolved at send time.
 * No binding = `suppressed`: connecting later does not resend old notices.
 */
async function deliverToOwner(
  db: DatabaseProvider,
  attempt: NotificationDeliveryAttemptRow,
  owner: string,
  recipient: NonNullable<ReturnType<typeof automationDeliveryRecipient.parse>>,
  content: {
    markdown: string;
    email: { subject: string; body_text: string; body_html: string };
    emailContext: { sessionId?: string; taskId?: number };
  },
): Promise<DeliveryResult> {
  if (attempt.channel === 'feishu' && recipient.kind === 'feishu_user') {
    if (recipient.userId !== owner) return { ok: false, error: 'Feishu recipient is not the notification owner' };
    const binding = await db.providerTokens.get(recipient.userId, FEISHU_PROVIDER, null);
    if (!binding?.provider_user_id) return { ok: false, suppressed: 'Notification owner has not connected Feishu' };
    return sendCardMarkdown(binding.provider_user_id, content.markdown);
  }

  if (attempt.channel === 'wecom' && recipient.kind === 'wecom_user') {
    if (recipient.userId !== owner) return { ok: false, error: 'WeCom recipient is not the notification owner' };
    const binding = await db.providerTokens.get(recipient.userId, WECOM_PROVIDER, null);
    if (!binding?.provider_user_id) return { ok: false, suppressed: 'Notification owner has not connected WeCom' };
    return sendAppMarkdown(binding.provider_user_id, content.markdown);
  }

  if (attempt.channel === 'email' && recipient.kind === 'email_user') {
    if (recipient.userId !== owner) return { ok: false, error: 'Email recipient is not the notification owner' };
    const user = await db.users.getById(recipient.userId);
    if (!user?.email) return { ok: false, suppressed: 'Notification owner has no usable email address' };
    return sendFromSharedMailbox(db, { address: user.email, name: user.nickname ?? undefined }, content.email, {
      userId: owner,
      origin: 'automation',
      ...content.emailContext,
    });
  }

  return { ok: false, error: `Channel ${attempt.channel} does not match its recipient envelope` };
}

/**
 * Execute exactly one already-leased attempt.
 *
 * Recipient envelopes are server-generated and deliberately absent from the
 * user-visible notification payload; DM and email recipients are always the
 * notification's owner, resolved to an address only at send time.
 */
export async function deliverNotificationAttempt(
  db: DatabaseProvider,
  attempt: NotificationDeliveryAttemptRow,
): Promise<DeliveryResult> {
  const notification = await db.notifications.get(attempt.notification_id);
  if (!notification) return { ok: false, error: 'Permanent notification no longer exists' };
  const recipient = automationDeliveryRecipient.parse(attempt.recipient);
  if (!recipient) return { ok: false, error: 'Notification delivery recipient envelope is invalid' };
  const stored = safeJsonParse(notification.payload, null);

  const message = parseMessageNotificationPayload(stored);
  if (message) {
    if (recipient.kind === 'wecom_webhook' || recipient.kind === 'feishu_webhook') {
      return { ok: false, error: 'Message notifications go to their owner only, never to a group webhook' };
    }
    const owner = await db.users.getById(notification.user_id);
    const label = OPEN_LABEL[botsLocale(owner?.locale)];
    const link = absoluteLink(message.href);
    const markdown = messageMarkdown(message, link, label);
    const body = flattenForDelivery(message.markdown);
    return deliverToOwner(db, attempt, notification.user_id, recipient, {
      markdown,
      email: {
        subject: message.title,
        body_text: [message.title, '', body, ...(link ? ['', `${label}: ${link}`] : [])].join('\n'),
        body_html: renderNotificationEmail({ heading: message.title, body, link: link ? { url: link, label } : null }),
      },
      emailContext: {},
    });
  }

  const payload = parseAutomationResultNotificationPayload(stored);
  if (!payload) return { ok: false, error: 'Notification has no supported durable delivery payload' };
  const task = { name: payload.task_name };
  const outcome = {
    status: payload.status,
    summary: payload.summary,
    sessionId: payload.session_id,
  };
  // The write receipt travels in the payload, so every channel and every retry
  // renders the same facts without re-querying Runtime.
  const writes = payload.writes;

  if (attempt.channel === 'wecom' && recipient.kind === 'wecom_webhook') {
    const result = await sendWeComMarkdown(recipient.webhook, buildTaskNotification(task, outcome, writes));
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? `WeCom webhook returned HTTP ${result.status ?? 'unknown'}` };
  }

  if (attempt.channel === 'feishu' && recipient.kind === 'feishu_webhook') {
    const result = await sendFeishuMarkdown(recipient.webhook, buildTaskNotification(task, outcome, writes));
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? `Feishu webhook returned HTTP ${result.status ?? 'unknown'}` };
  }

  return deliverToOwner(db, attempt, notification.user_id, recipient, {
    markdown: buildTaskNotification(task, outcome, writes),
    email: buildTaskEmail(task, outcome, writes),
    emailContext: { sessionId: payload.session_id, taskId: payload.task_id },
  });
}

export async function startNotificationDeliveryWorker(
  options: NotificationDeliveryWorkerOptions,
): Promise<NotificationDeliveryWorker> {
  const { db } = options;
  const workerId = options.workerId ?? `notification-api-${process.pid}-${randomUUID().slice(0, 8)}`;
  const leaseMs = Math.max(options.leaseMs ?? DEFAULT_LEASE_MS, 1_000);
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), 100);
  const channels = [...(options.channels ?? AUTOMATION_DELIVERY_CHANNELS)];
  const now = options.now ?? (() => new Date());
  let running = false;
  let stopped = false;

  const processAttempt = async (attempt: NotificationDeliveryAttemptRow): Promise<void> => {
    try {
      const result = await deliverNotificationAttempt(db, attempt);
      if (result.suppressed) {
        await db.notifications.settleDelivery({
          id: attempt.id,
          expected_version: attempt.version,
          worker_id: workerId,
          status: 'suppressed',
          reason: result.suppressed,
          at: now(),
        });
        return;
      }
      if (result.ok) {
        await db.notifications.acknowledgeDelivery({
          id: attempt.id,
          expected_version: attempt.version,
          worker_id: workerId,
          at: now(),
        });
        return;
      }
      const failed = await db.notifications.failDelivery({
        id: attempt.id,
        expected_version: attempt.version,
        worker_id: workerId,
        error: result.error ?? 'Notification delivery failed',
        at: now(),
        retry_at: retryAt(attempt.attempts, now()),
      });
      if (failed.status === 'dead_letter') {
        logger.error('[notification-delivery] attempt reached dead letter', {
          attemptId: attempt.id,
          notificationId: attempt.notification_id,
          channel: attempt.channel,
          error: result.error ?? 'Notification delivery failed',
        });
      }
    } catch (error) {
      // Network functions can throw before returning their structured result.
      // Return the lease to the durable queue when it is still ours. If the
      // lease was lost, the next claimer is already authoritative.
      try {
        const failed = await db.notifications.failDelivery({
          id: attempt.id,
          expected_version: attempt.version,
          worker_id: workerId,
          error: toErrorMessage(error),
          at: now(),
          retry_at: retryAt(attempt.attempts, now()),
        });
        if (failed.status === 'dead_letter') {
          logger.error('[notification-delivery] thrown attempt reached dead letter', {
            attemptId: attempt.id,
            notificationId: attempt.notification_id,
            channel: attempt.channel,
            error: toErrorMessage(error),
          });
        }
      } catch (leaseError) {
        logger.warn('[notification-delivery] could not settle attempt after delivery error', {
          attemptId: attempt.id,
          notificationId: attempt.notification_id,
          channel: attempt.channel,
          error: toErrorMessage(leaseError),
        });
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const attempts = await db.notifications.claimDeliveries({
        worker_id: workerId,
        lease_ms: leaseMs,
        channels,
        limit: batchSize,
        at: now(),
      });
      const pushes = attempts.filter((attempt) => attempt.channel === 'mobile_push');
      const others = attempts.filter((attempt) => attempt.channel !== 'mobile_push');
      // Start every claimed network request promptly so a slow first channel
      // cannot let a later row's lease expire before it even begins.
      await Promise.all([
        ...others.map(processAttempt),
        deliverPushAttempts(pushes, { db, workerId, now, retryAt, fetch: options.pushFetch }),
      ]);
    } finally {
      running = false;
    }
  };

  if (!options.skipBootPass) await runOnce();
  const timer = setInterval(
    () => void runOnce().catch((error) => logger.error('[notification-delivery] worker pass failed', { error })),
    Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 250),
  );
  timer.unref();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
