/**
 * Channels: where notifications go besides the in-app center (NTF-03…06, SET-02, ADM-05,
 * CHN-02…04). Email goes through the mail capability (modules/mail sets it up); Feishu, WeCom
 * and push are provider instances of their own (instances.ts).
 *
 * - `notifications.publish` stores a notification and, in the same transaction, `enqueue` writes
 *   one `deliver_notification` job per channel the member wants for its category and can use now
 *   (set up by an admin and connected for them): one job per notification and channel, ever.
 * - Same source and category within COLLAPSE_WINDOW_MS make one message per channel: a job still
 *   waiting takes the newer notification in (the message says how many); after one went out, the
 *   newer one is recorded as collapsed. A lock per source keeps two processes from both sending.
 * - A worker in every API process claims due jobs with a lease and delivers them (deliver.ts);
 *   failures back off and retry, and a claim whose process died goes back to the queue.
 * - 设置 → 通知 offers only the channels a member can use; 管理 → 渠道 edits the Feishu, WeCom
 *   and push instances, which the providers service audits.
 */

import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { ADMIN_CHANNELS } from '@greenhouse/contract';
import type {
  AdminChannel,
  AdminChannels,
  ChannelInput,
  ChannelStatus,
  ChannelTest,
  NotificationSettings as SettingsView,
  PushDevice,
  PushDeviceList,
  PushDeviceRegistered,
  RegisterPushDeviceInput,
  UpdateNotificationSettingsInput,
  UpdatePushDeviceInput,
} from '@greenhouse/contract';
import {
  DELIVERY_CHANNELS,
  NOTIFICATION_CATEGORIES,
  getDb,
  jobs,
  members,
  notifications,
  transaction,
  type DeliveryChannel,
  type Member,
  type NotificationRow,
} from '@greenhouse/db';
import type { Capability } from '@greenhouse/providers';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { AppConfig } from '../../config/index.js';
import { ApiError, notFound } from '../../http/errors.js';
import { claimJobs, enqueueJob, pruneJobs, releaseExpiredClaims, settleJob, type JobOutcome } from '../../jobs.js';
import type { Arrangement, ProvidersService } from '../../providers/service.js';
import { RateLimiter } from '../../security/rate-limit.js';
import {
  createDeliverer,
  createPass,
  DELIVER_JOB,
  deliveryKey,
  linkedAccount,
  localeOf,
  RECEIPTS_JOB,
} from './deliver.js';
import {
  activeDevices,
  deliverableDevices,
  disableDevice,
  ownDevice,
  registerDevice,
  toPushDevice,
  updatePrefs,
} from './devices.js';
import {
  CHANNEL_PROVIDER,
  channelInstance,
  channelSettings,
  configured,
  mailReady,
  providerChange,
  secretsSet,
} from './instances.js';
import {
  categoryOf,
  COLLAPSE_WINDOW_MS,
  deliveryDelayMs,
  effectiveSettings,
  kindsOf,
  mergeSettings,
} from './settings.js';

const JOB_KINDS = [DELIVER_JOB, RECEIPTS_JOB];
const POLL_MS = 2_000;
const BATCH = 20;
const LEASE_MS = 2 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
/** Settled delivery jobs are kept a month: long enough for 管理 → 渠道 to show the last success. */
const KEEP_JOBS_MS = 30 * 24 * 60 * 60_000;
const TEST_PUSH_TTL_S = 5 * 60;

/** What notifications.publish needs from channels. */
export interface Deliveries {
  /** Joins the open transaction: the jobs commit with the notification. */
  enqueue(row: NotificationRow): Promise<void>;
  /** A notification was committed: deliver soon rather than at the next poll. */
  wake(): void;
}

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;

const testText = (locale: 'zh' | 'en', workspace: string) =>
  locale === 'zh'
    ? `这是一条测试消息：${workspace} 能通过这里找到你。`
    : `This is a test message: ${workspace} can reach you here.`;

export function createChannelsService(deps: { config: AppConfig; providers: ProvidersService }) {
  // Background timers start in the service context, never a request's open transaction.
  const workerContext = new AsyncResource('channels-worker');
  const deliverer = createDeliverer({ providers: deps.providers, publicUrl: deps.config.PUBLIC_URL });
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const testLimiter = new RateLimiter(1, 10_000);

  async function memberRow(id: string): Promise<Member> {
    const [row] = await getDb().select().from(members).where(eq(members.id, id));
    if (!row) throw notFound('Member');
    return row;
  }

  /** The channels (of those asked about) a member can use now: set up, and connected for them. */
  async function offered(
    member: Pick<Member, 'id' | 'authVersion'>,
    arranged: Record<Capability, Arrangement>,
    among: readonly DeliveryChannel[] = DELIVERY_CHANNELS,
  ): Promise<DeliveryChannel[]> {
    const out: DeliveryChannel[] = [];
    for (const channel of among) {
      if (channel === 'email') {
        if (mailReady(arranged)) out.push(channel);
        continue;
      }
      if (!configured(channelInstance(arranged, channel))) continue;
      if (channel === 'feishu' || channel === 'wecom') {
        if (!(await linkedAccount(member.id, channel))) continue;
      } else if (channel === 'push') {
        if (!(await deliverableDevices(member)).length) continue;
      }
      out.push(channel);
    }
    return out;
  }

  /** A pending job takes the newer notification in; true when it did (it had not been claimed yet). */
  async function fold(jobId: string, notificationId: string): Promise<boolean> {
    const [row] = await getDb()
      .update(jobs)
      .set({
        payload: sql`${jobs.payload} || jsonb_build_object('notification_id', ${notificationId}::text, 'count', coalesce((${jobs.payload}->>'count')::int, 1) + 1)`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'pending')))
      .returning({ id: jobs.id });
    return !!row;
  }

  async function enqueueChannel(row: NotificationRow, channel: DeliveryChannel, earlier: string[], delayMs: number) {
    const dedupeKey = deliveryKey(row.id, channel);
    const payload = { notification_id: row.id, channel };
    if (earlier.length) {
      const [previous] = await getDb()
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(
          and(
            inArray(
              jobs.dedupeKey,
              earlier.map((id) => deliveryKey(id, channel)),
            ),
            inArray(jobs.status, ['pending', 'claimed', 'succeeded']),
          ),
        )
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(1);
      if (previous) {
        const folded = previous.status === 'pending' && (await fold(previous.id, row.id));
        await enqueueJob({
          kind: DELIVER_JOB,
          dedupeKey,
          payload,
          suppressed: { reason: folded ? 'folded' : 'collapsed', into: previous.id },
        });
        return;
      }
    }
    await enqueueJob({ kind: DELIVER_JOB, dedupeKey, payload, delayMs });
  }

  async function settingsView(member: Member): Promise<SettingsView> {
    const effective = effectiveSettings(member.notificationSettings);
    const channels = await offered(member, await deps.providers.arrangement());
    const categories = Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((category) => [
        category,
        Object.fromEntries(channels.map((channel) => [channel, effective.categories[category][channel]])),
      ]),
    ) as SettingsView['categories'];
    return { channels, categories, previews: effective.previews };
  }

  async function pushReady(): Promise<boolean> {
    return configured(channelInstance(await deps.providers.arrangement(), 'push'));
  }

  /** Last success and last failure per channel, from the delivery jobs (kept for a month). */
  async function deliveryHistory(): Promise<
    Map<string, { lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null }>
  > {
    const failing = sql`${jobs.status} in ('pending', 'dead') and ${jobs.lastError} is not null`;
    const rows = await getDb().execute(sql`
      select ${jobs.payload}->>'channel' as channel,
        max(${jobs.updatedAt}) filter (where ${jobs.status} = 'succeeded') as last_success_at,
        max(${jobs.updatedAt}) filter (where ${failing}) as last_error_at,
        (array_agg(${jobs.lastError} order by ${jobs.updatedAt} desc) filter (where ${failing}))[1] as last_error
      from ${jobs}
      where ${jobs.kind} = ${DELIVER_JOB}
      group by 1`);
    return new Map(
      [...(rows as unknown as Record<string, unknown>[])].map((row) => [
        String(row.channel),
        {
          lastSuccessAt: iso(row.last_success_at),
          lastError: typeof row.last_error === 'string' ? row.last_error : null,
          lastErrorAt: iso(row.last_error_at),
        },
      ]),
    );
  }

  async function channelList(): Promise<AdminChannels> {
    const [arranged, history] = await Promise.all([deps.providers.arrangement(), deliveryHistory()]);
    return {
      items: ADMIN_CHANNELS.map((channel) => {
        const found = channelInstance(arranged, channel);
        const past = history.get(channel);
        return {
          channel,
          configured: configured(found),
          source: found ? (found.instance.source === 'env' ? 'env' : 'workspace') : null,
          enabled: found?.instance.enabled ?? false,
          secrets_set: found ? secretsSet(channel, found.instance.secrets_set) : [],
          last_success_at: past?.lastSuccessAt ?? null,
          last_error: past?.lastError ?? null,
          last_error_at: past?.lastErrorAt ?? null,
          settings: channelSettings(channel, found?.instance.config),
        } as ChannelStatus;
      }),
    };
  }

  // ─── the worker ──────────────────────────────────────────

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let started = false;
  let prunedAt = 0;

  async function settle(job: Parameters<typeof settleJob>[0], outcome: JobOutcome) {
    const status = await settleJob(job, owner, outcome);
    if (status === 'dead') {
      logger.warn('[channels] gave up on a job', {
        job: job.id,
        kind: job.kind,
        error: 'error' in outcome ? outcome.error : undefined,
      });
    }
  }

  /** One pass: return dead claims to the queue, claim what is due, deliver it. How many were claimed. */
  async function runOnce(): Promise<number> {
    await releaseExpiredClaims(JOB_KINDS);
    const claimed = await claimJobs(JOB_KINDS, owner, { limit: BATCH, leaseMs: LEASE_MS });
    const pass = createPass(deps.providers);
    await Promise.all(
      claimed.map(async (job) => {
        let outcome: JobOutcome;
        try {
          outcome =
            job.kind === DELIVER_JOB ? await deliverer.delivery(job, pass) : await deliverer.receipts(job, pass);
        } catch (error) {
          outcome = { status: 'retry', error: toErrorMessage(error).slice(0, 500) };
        }
        await settle(job, outcome).catch((error: unknown) =>
          logger.warn('[channels] could not settle a job', { job: job.id, error: toErrorMessage(error) }),
        );
      }),
    );
    if (Date.now() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = Date.now();
      await pruneJobs(JOB_KINDS, KEEP_JOBS_MS);
    }
    return claimed.length;
  }

  function schedule(delay: number) {
    if (!started || running) return;
    if (timer) clearTimeout(timer);
    timer = workerContext.runInAsyncScope(() =>
      setTimeout(() => {
        timer = null;
        running = (async () => {
          // A full batch means more may be waiting.
          while (started && (await runOnce()) === BATCH);
        })()
          .catch((error: unknown) => logger.warn('[channels] a delivery pass failed', { error: toErrorMessage(error) }))
          .finally(() => {
            running = null;
            schedule(POLL_MS);
          });
      }, delay),
    );
    timer.unref?.();
  }

  return {
    // ─── notifications.publish ─────────────────────────────

    async enqueue(row: NotificationRow): Promise<void> {
      const [member] = await getDb().select().from(members).where(eq(members.id, row.memberId));
      if (!member || member.status !== 'active') return;
      const category = categoryOf(row.kind);
      const switches = effectiveSettings(member.notificationSettings).categories[category];
      const wanted = DELIVERY_CHANNELS.filter((channel) => switches[channel]);
      if (!wanted.length) return;
      const channels = await offered(member, await deps.providers.arrangement(), wanted);
      if (!channels.length) return;
      let earlier: string[] = [];
      if (row.targetType && row.targetId) {
        await getDb().execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`notify:${row.memberId}:${category}:${row.targetType}:${row.targetId}`}, 0))`,
        );
        const recent = await getDb()
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.memberId, row.memberId),
              eq(notifications.targetType, row.targetType),
              eq(notifications.targetId, row.targetId),
              inArray(notifications.kind, kindsOf(category)),
              ne(notifications.id, row.id),
              gte(
                notifications.createdAt,
                sql`${row.createdAt}::timestamptz - (${COLLAPSE_WINDOW_MS} * interval '1 millisecond')`,
              ),
            ),
          )
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(20);
        earlier = recent.map((entry) => entry.id);
      }
      for (const channel of channels) await enqueueChannel(row, channel, earlier, deliveryDelayMs(row.kind));
    },

    wake(): void {
      schedule(0);
    },

    // ─── 设置 → 通知 ────────────────────────────────────────

    async settings(memberId: string): Promise<SettingsView> {
      return settingsView(await memberRow(memberId));
    },

    async saveSettings(memberId: string, input: UpdateNotificationSettingsInput): Promise<SettingsView> {
      const member = await transaction(async (db) => {
        const [current] = await db.select().from(members).where(eq(members.id, memberId)).for('update');
        if (!current) throw notFound('Member');
        const [updated] = await db
          .update(members)
          .set({ notificationSettings: mergeSettings(current.notificationSettings, input), updatedAt: sql`now()` })
          .where(eq(members.id, memberId))
          .returning();
        return updated!;
      });
      return settingsView(member);
    },

    // ─── push devices ───────────────────────────────────────

    async devices(memberId: string): Promise<PushDeviceList> {
      if (!(await pushReady())) return { devices: [], enabled: false };
      return { devices: (await activeDevices(memberId)).map(toPushDevice), enabled: true };
    },

    /** With pushes off here nothing is stored. */
    async registerDevice(memberId: string, input: RegisterPushDeviceInput): Promise<PushDeviceRegistered> {
      if (!(await pushReady())) return { device: null, enabled: false };
      const member = await memberRow(memberId);
      return { device: toPushDevice(await registerDevice(member, input)), enabled: true };
    },

    async updateDevice(memberId: string, id: string, input: UpdatePushDeviceInput): Promise<{ device: PushDevice }> {
      const row = await updatePrefs(memberId, id, input.prefs);
      if (!row) throw notFound('Push device');
      return { device: toPushDevice(row) };
    },

    /** Unregistering only disables: registering the same token again brings it back. */
    async unregisterDevice(memberId: string, id: string): Promise<{ ok: true }> {
      const device = await ownDevice(memberId, id);
      if (!device) throw notFound('Push device');
      await disableDevice(device.id, 'unregistered');
      return { ok: true };
    },

    /** One push straight to Expo, outside the queue, so a self-hoster sees at once whether it gets through. */
    async testDevice(memberId: string, id: string): Promise<{ ok: true }> {
      const arranged = await deps.providers.arrangement();
      const found = channelInstance(arranged, 'push');
      if (!configured(found)) throw new ApiError(503, 'push_disabled', 'This deployment sends no pushes.');
      const device = await ownDevice(memberId, id);
      if (!device) throw notFound('Push device');
      if (device.disabledAt) throw new ApiError(409, 'device_disabled', 'This phone is unregistered.');
      const wait = testLimiter.hit(device.id);
      if (wait) throw new ApiError(429, 'too_soon', 'One test every 10 seconds per phone.', { retry_after: wait });
      const push = (await deps.providers.byId('push', found!.instance.id, {}))?.client;
      if (!push) throw new ApiError(503, 'push_disabled', 'This deployment sends no pushes.');
      const member = await memberRow(memberId);
      const workspaceName = await createPass(deps.providers).workspaceName();
      const [ticket] = await push.send([
        {
          to: device.token,
          projectId: device.projectId,
          title: workspaceName,
          body: testText(localeOf(member), workspaceName),
          data: { v: 1, s: device.clientRef, u: member.id, k: 'test', nid: 'test' },
          sound: 'default',
          priority: 'high',
          expiration: Math.floor(Date.now() / 1000) + TEST_PUSH_TTL_S,
        },
      ]);
      if (ticket?.status === 'ok') return { ok: true };
      if (ticket?.status === 'error' && ticket.code === 'DeviceNotRegistered') {
        await disableDevice(device.id, 'device_not_registered');
        throw new ApiError(409, 'device_not_registered', 'The app is no longer on this phone.');
      }
      const error =
        ticket?.status === 'error' ? `${ticket.code ?? 'error'}: ${ticket.message}` : (ticket?.error ?? 'no answer');
      throw new ApiError(502, 'send_failed', `The push did not go out: ${error}`);
    },

    // ─── 管理 → 渠道 ────────────────────────────────────────

    list: channelList,

    /**
     * Saves one channel. The first save creates the workspace instance; settings from env become
     * an editable copy that takes their place. Either way it serves first among its kind.
     */
    async save<C extends AdminChannel>(actorId: string, channel: C, input: ChannelInput[C]): Promise<ChannelStatus> {
      const { capability, kind, name } = CHANNEL_PROVIDER[channel];
      await transaction(async () => {
        const found = channelInstance(await deps.providers.arrangement(), channel);
        const change = providerChange(channel, input, found?.instance.config);
        let id: string;
        if (!found) {
          id = (
            await deps.providers.create(actorId, 'workspace', {
              capability,
              kind,
              name,
              config: change.config ?? {},
              secrets: change.secrets ?? {},
            })
          ).id;
          if (change.enabled === false) await deps.providers.update(actorId, 'workspace', id, { enabled: false });
        } else {
          id =
            found.instance.source === 'env'
              ? (await deps.providers.copy(actorId, found.instance.id)).id
              : found.instance.id;
          if (Object.keys(change).length) await deps.providers.update(actorId, 'workspace', id, change);
        }
        const { order, instances } = (await deps.providers.arrangement())[capability];
        const firstOfKind = order.find((entry) => instances.find((instance) => instance.id === entry)?.kind === kind);
        if (firstOfKind !== id) {
          await deps.providers.setBinding(actorId, capability, {
            instance_ids: [id, ...order.filter((entry) => entry !== id)],
            defaults: {},
            policy: {},
          });
        }
      });
      return (await channelList()).items.find((item) => item.channel === channel)!;
    },

    /** A test message to the admin: their linked account, their phones. */
    async test(actorId: string, channel: AdminChannel): Promise<ChannelTest> {
      const started = Date.now();
      const found = channelInstance(await deps.providers.arrangement(), channel);
      const notReady = () => new ApiError(409, 'channel_not_configured', 'Set this channel up first.');
      if (!configured(found)) throw notReady();
      const id = found!.instance.id;
      const member = await memberRow(actorId);
      const workspaceName = await createPass(deps.providers).workspaceName();
      const message = testText(localeOf(member), workspaceName);
      let delivered = 0;
      try {
        if (channel === 'feishu' || channel === 'wecom') {
          const im = (await deps.providers.byId('im', id, {}))?.client;
          if (!im) throw notReady();
          await im.verify();
          const account = await linkedAccount(member.id, channel);
          if (account) {
            await im.sendText(account, message);
            delivered = 1;
          }
        } else {
          const push = (await deps.providers.byId('push', id, {}))?.client;
          if (!push) throw notReady();
          const devices = await deliverableDevices(member);
          if (!devices.length) {
            await push.receipts(['00000000-0000-0000-0000-000000000000']);
          } else {
            const tickets = await push.send(
              devices.map((device) => ({
                to: device.token,
                projectId: device.projectId,
                title: workspaceName,
                body: message,
                data: { v: 1, s: device.clientRef, u: member.id, k: 'test', nid: 'test' },
                sound: 'default' as const,
                priority: 'high' as const,
                expiration: Math.floor(Date.now() / 1000) + TEST_PUSH_TTL_S,
              })),
            );
            for (const [index, ticket] of tickets.entries()) {
              if (ticket.status === 'ok') delivered++;
              else if (ticket.status === 'error' && ticket.code === 'DeviceNotRegistered') {
                await disableDevice(devices[index]!.id, 'device_not_registered');
              }
            }
            const refused = tickets.find((ticket) => ticket.status !== 'ok');
            if (!delivered && refused) {
              throw new Error(
                refused.status === 'error' ? `${refused.code ?? 'error'}: ${refused.message}` : refused.error,
              );
            }
          }
        }
        return { ok: true, delivered, latency_ms: Date.now() - started, error: null };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        return { ok: false, delivered, latency_ms: Date.now() - started, error: toErrorMessage(error).slice(0, 300) };
      }
    },

    // ─── the worker ─────────────────────────────────────────

    runOnce,

    /** Delivers in this process: every couple of seconds, and at once after a notification. */
    start(): void {
      if (started) return;
      started = true;
      schedule(0);
    },

    async stop(): Promise<void> {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}

export type ChannelsService = ReturnType<typeof createChannelsService>;
