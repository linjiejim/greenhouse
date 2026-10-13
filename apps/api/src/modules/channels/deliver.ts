/**
 * What the delivery worker does with one job (NTF-03…06). Before sending, everything is checked
 * again, because minutes may have passed since the notification was written: the notification
 * and its member still exist, the member still wants this channel for its category, the card is
 * still pending, nobody read it in the app meanwhile, and the channel is still set up and
 * connected. A delivery that no longer makes sense is `suppressed` with its reason.
 *
 * Outcomes: sent → succeeded; refused for good (UndeliverableError, a malformed push request) →
 * dead; anything else → retried with backoff. A push job remembers the phones it reached, so a
 * retry never pushes the same phone twice, and leaves a receipts check for fifteen minutes later.
 */

import { and, count, eq } from 'drizzle-orm';
import {
  agents,
  connections,
  DELIVERY_CHANNELS,
  getDb,
  members,
  notifications,
  requests,
  workspace,
  type DeliveryChannel,
  type JobRow,
  type Member,
  type NotificationRow,
} from '@greenhouse/db';
import { UndeliverableError, type Capability, type PushMessage } from '@greenhouse/providers';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { enqueueJob, type JobOutcome } from '../../jobs.js';
import type { Arrangement, ProvidersService } from '../../providers/service.js';
import { deliverableDevices, disableDevice, prefsOf } from './devices.js';
import { CHANNEL_PROVIDER, channelInstance, configured } from './instances.js';
import { isRunEnd, pushData, pushDecision, pushMessage } from './push.js';
import { deepLink, linkPath, renderEmail, renderIm, renderPush, type Locale, type Rendering } from './render.js';
import { categoryOf, effectiveSettings } from './settings.js';

export const DELIVER_JOB = 'deliver_notification';
export const RECEIPTS_JOB = 'push_receipts';
/** Expo keeps receipts for a day and has most of them within fifteen minutes. */
export const RECEIPTS_DELAY_MS = 15 * 60_000;
const RECEIPTS_ATTEMPTS = 4;

export const deliveryKey = (notificationId: string, channel: DeliveryChannel) => `deliver:${notificationId}:${channel}`;

/** What one worker pass reads once for all its jobs. */
export interface Pass {
  arranged(): Promise<Record<Capability, Arrangement>>;
  workspaceName(): Promise<string>;
}

export function createPass(providers: ProvidersService): Pass {
  let arranged: Promise<Record<Capability, Arrangement>> | null = null;
  let name: Promise<string> | null = null;
  return {
    arranged: () => (arranged ??= providers.arrangement()),
    workspaceName: () =>
      (name ??= getDb()
        .select({ name: workspace.name })
        .from(workspace)
        .then(([row]) => row?.name ?? 'Greenhouse')),
  };
}

export const localeOf = (member: Pick<Member, 'locale'>): Locale => (member.locale === 'en' ? 'en' : 'zh');

/** A failure in words that hold no secret, and whether a retry could help. */
function failed(error: unknown, label: string): JobOutcome {
  const message = `${label}: ${toErrorMessage(error)}`.slice(0, 500);
  return error instanceof UndeliverableError ? { status: 'dead', error: message } : { status: 'retry', error: message };
}

const suppressed = (reason: string, result: Record<string, unknown> = {}): JobOutcome => ({
  status: 'suppressed',
  result: { ...result, reason },
});

export async function pendingCount(memberId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(requests)
    .where(and(eq(requests.memberId, memberId), eq(requests.status, 'pending')));
  return row?.n ?? 0;
}

/** The member's linked Feishu or WeCom account, when it is active. */
export async function linkedAccount(memberId: string, channel: 'feishu' | 'wecom'): Promise<string | null> {
  const [row] = await getDb()
    .select({ externalId: connections.externalId })
    .from(connections)
    .where(and(eq(connections.memberId, memberId), eq(connections.kind, channel), eq(connections.status, 'active')));
  return row?.externalId ?? null;
}

export function createDeliverer(deps: { providers: ProvidersService; publicUrl: string }) {
  async function clientOf<C extends 'mail' | 'im' | 'push'>(pass: Pass, channel: DeliveryChannel, capability: C) {
    const found = channelInstance(await pass.arranged(), channel);
    if (!configured(found)) return null;
    return (await deps.providers.byId(capability, found!.instance.id, {}))?.client ?? null;
  }

  async function sendPush(
    job: JobRow,
    pass: Pass,
    context: {
      notification: NotificationRow;
      member: Member;
      rendering: Rendering;
      requestExpiresAt: string | null;
    },
  ): Promise<JobOutcome> {
    const { notification, member, rendering } = context;
    const client = await clientOf(pass, 'push', 'push');
    if (!client) return suppressed('not_configured');
    const devices = await deliverableDevices(member);
    if (!devices.length) return suppressed('no_device');
    const reached = new Set(((job.result?.sent as string[] | undefined) ?? []).filter((id) => typeof id === 'string'));
    const badge = await pendingCount(member.id);
    const runEnd = isRunEnd(notification);
    const outgoing: { deviceId: string; message: PushMessage }[] = [];
    for (const device of devices) {
      if (reached.has(device.id)) continue;
      const prefs = prefsOf(device);
      const decision = pushDecision({
        category: rendering.category,
        prefs,
        runEnd,
        requestKind: rendering.requestKind ?? null,
        requestExpiresAt: context.requestExpiresAt,
        createdAt: notification.createdAt,
        now: Date.now(),
      });
      if (!decision.send) continue;
      outgoing.push({
        deviceId: device.id,
        message: pushMessage({
          device,
          decision,
          data: pushData({
            notification,
            category: rendering.category,
            memberId: member.id,
            clientRef: device.clientRef,
          }),
          text: renderPush({ ...rendering, previews: rendering.previews && prefs.preview }),
          badge,
          wake: runEnd && prefs.live_activity,
        }),
      });
    }
    if (!outgoing.length) {
      return reached.size ? { status: 'succeeded', result: { sent: [...reached] } } : suppressed('device_off');
    }

    const tickets = await client.send(outgoing.map((entry) => entry.message));
    const receipts: { id: string; device_id: string }[] = [];
    const retries: string[] = [];
    let fatal: string | null = null;
    for (const [index, ticket] of tickets.entries()) {
      const { deviceId } = outgoing[index]!;
      if (ticket.status === 'ok') {
        reached.add(deviceId);
        if (ticket.id) receipts.push({ id: ticket.id, device_id: deviceId });
      } else if (ticket.status === 'error') {
        if (ticket.code === 'DeviceNotRegistered') {
          // The app is gone from that phone: never push to it again until it registers anew.
          await disableDevice(deviceId, 'device_not_registered');
        } else if (ticket.code === 'MessageTooBig') {
          logger.error('[channels] a push was too big to send', { job: job.id, device: deviceId });
        } else {
          retries.push(`${ticket.code ?? 'error'}: ${ticket.message}`);
        }
      } else if (ticket.status === 'retry') {
        retries.push(ticket.error);
      } else {
        fatal = ticket.error;
      }
    }
    if (receipts.length) {
      await enqueueJob({
        kind: RECEIPTS_JOB,
        dedupeKey: `receipts:${job.id}:${job.attempts}`,
        payload: { tickets: receipts },
        delayMs: RECEIPTS_DELAY_MS,
        maxAttempts: RECEIPTS_ATTEMPTS,
      });
    }
    const result = { sent: [...reached] };
    if (fatal) return { status: 'dead', error: `Expo refused the request: ${fatal}`.slice(0, 500), result };
    if (retries.length) return { status: 'retry', error: `Expo: ${retries[0]}`.slice(0, 500), result };
    return { status: 'succeeded', result };
  }

  return {
    async delivery(job: JobRow, pass: Pass): Promise<JobOutcome> {
      const payload = job.payload as { notification_id?: unknown; channel?: unknown; count?: unknown };
      const channel = payload.channel as DeliveryChannel;
      if (typeof payload.notification_id !== 'string' || !DELIVERY_CHANNELS.includes(channel)) {
        return { status: 'dead', error: 'The job does not name a notification and a channel.' };
      }
      const [notification] = await getDb()
        .select()
        .from(notifications)
        .where(eq(notifications.id, payload.notification_id));
      if (!notification) return suppressed('notification_gone');
      const [member] = await getDb().select().from(members).where(eq(members.id, notification.memberId));
      if (!member || member.status !== 'active') return suppressed('member_inactive');
      const category = categoryOf(notification.kind);
      const settings = effectiveSettings(member.notificationSettings);
      if (!settings.categories[category][channel]) return suppressed('channel_off');
      if (notification.readAt) return suppressed('read');
      let request: { kind: string; expiresAt: string | null } | null = null;
      if (notification.requestId) {
        const [row] = await getDb()
          .select({ kind: requests.kind, status: requests.status, expiresAt: requests.expiresAt })
          .from(requests)
          .where(eq(requests.id, notification.requestId));
        if (!row || row.status !== 'pending' || (row.expiresAt && Date.parse(row.expiresAt) <= Date.now())) {
          return suppressed('request_settled');
        }
        request = row;
      }

      const [agent] = notification.agentId
        ? await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, notification.agentId))
        : [];
      const workspaceName = await pass.workspaceName();
      const rendering: Rendering = {
        locale: localeOf(member),
        category,
        kind: notification.kind,
        requestKind: request?.kind ?? null,
        from: agent?.name ?? workspaceName,
        workspace: workspaceName,
        title: notification.title,
        body: notification.body,
        link: deepLink(deps.publicUrl, linkPath(notification)),
        previews: settings.previews,
        count: typeof payload.count === 'number' && payload.count > 1 ? payload.count : 1,
      };

      try {
        switch (channel) {
          case 'email': {
            const mail = await clientOf(pass, 'email', 'mail');
            if (!mail) return suppressed('not_configured');
            await mail.send({ to: member.email, toName: member.name, ...renderEmail(rendering) });
            return { status: 'succeeded' };
          }
          case 'feishu':
          case 'wecom': {
            const im = await clientOf(pass, channel, 'im');
            if (!im) return suppressed('not_configured');
            const account = await linkedAccount(member.id, channel);
            if (!account) return suppressed('not_connected');
            await im.sendText(account, renderIm(rendering));
            return { status: 'succeeded' };
          }
          case 'push':
            return await sendPush(job, pass, {
              notification,
              member,
              rendering,
              requestExpiresAt: request?.expiresAt ?? null,
            });
        }
      } catch (error) {
        return failed(error, CHANNEL_PROVIDER[channel].name);
      }
    },

    /** Expo's verdict on accepted pushes: a phone without the app is disabled. */
    async receipts(job: JobRow, pass: Pass): Promise<JobOutcome> {
      const tickets = ((job.payload.tickets as { id?: unknown; device_id?: unknown }[] | undefined) ?? []).filter(
        (ticket): ticket is { id: string; device_id: string } =>
          typeof ticket.id === 'string' && typeof ticket.device_id === 'string',
      );
      if (!tickets.length) return { status: 'succeeded', result: { checked: 0 } };
      const client = await clientOf(pass, 'push', 'push');
      if (!client) return suppressed('not_configured');
      let receipts;
      try {
        receipts = await client.receipts(tickets.map((ticket) => ticket.id));
      } catch (error) {
        return { status: 'retry', error: `Expo receipts: ${toErrorMessage(error)}`, delayMs: RECEIPTS_DELAY_MS };
      }
      let missing = 0;
      let disabled = 0;
      for (const ticket of tickets) {
        const receipt = receipts[ticket.id];
        if (!receipt) missing++;
        else if (receipt.status === 'error' && receipt.code === 'DeviceNotRegistered') {
          await disableDevice(ticket.device_id, 'device_not_registered');
          disabled++;
        } else if (receipt.status === 'error') {
          logger.warn('[channels] Expo could not deliver a push', { job: job.id, code: receipt.code });
        }
      }
      const result = { checked: tickets.length, missing, disabled };
      if (missing && job.attempts < job.maxAttempts) {
        return { status: 'retry', error: `${missing} receipts are not ready yet`, delayMs: RECEIPTS_DELAY_MS, result };
      }
      return { status: 'succeeded', result };
    },
  };
}

export type Deliverer = ReturnType<typeof createDeliverer>;
