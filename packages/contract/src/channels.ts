import { z } from 'zod';
import { isoTime } from './common.js';

/** What a notification is about, as the delivery settings group it. */
export const NOTIFICATION_CATEGORIES = ['needs_you', 'replies', 'runs', 'other'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
/** Where notifications go besides the in-app center, which always has them. */
export const DELIVERY_CHANNELS = ['email', 'feishu', 'wecom', 'push'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

const channelSwitches = z.partialRecord(z.enum(DELIVERY_CHANNELS), z.boolean());

/** 设置 → 通知 (SET-02). */
export const notificationSettingsSchema = z.object({
  /**
   * The channels I can use now: set up by an admin and connected for me (my email address, a
   * linked Feishu or WeCom account, a phone with the app). Only these are offered.
   */
  channels: z.array(z.enum(DELIVERY_CHANNELS)),
  /** For each category, which of those channels deliver it. In-app always does. */
  categories: z.object({
    needs_you: channelSwitches,
    replies: channelSwitches,
    runs: channelSwitches,
    other: channelSwitches,
  }),
  /**
   * Off by default: pushes and messages say who wants what kind of thing, never its subject.
   * On: they name the subject; the content of needs-you cards and replies never leaves anyway.
   */
  previews: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/** Fields left out keep their value. */
export const updateNotificationSettingsInputSchema = z
  .object({
    categories: z
      .object({ needs_you: channelSwitches, replies: channelSwitches, runs: channelSwitches, other: channelSwitches })
      .partial()
      .strict(),
    previews: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateNotificationSettingsInput = z.input<typeof updateNotificationSettingsInputSchema>;

// ─── push devices (the iOS and Android apps) ─────────────────────────────

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
/** `ExponentPushToken[…]` (older SDKs: `ExpoPushToken[…]`). */
export const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;
/** An Expo project id (EAS `projectId`). */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The phone's own id for this workspace, echoed back in every push. */
const CLIENT_REF = /^[A-Za-z0-9._:-]{1,64}$/;

/** A phone's own switches. They only narrow what 设置 → 通知 allows, on that phone. */
export const pushPrefsSchema = z.object({
  needs_you: z.boolean(),
  /** Runs and schedules that finished. */
  done: z.boolean(),
  replies: z.boolean(),
  preview: z.boolean(),
  /** The phone shows background runs as Live Activities: a run's end also wakes the app. */
  live_activity: z.boolean(),
});
export type PushPrefs = z.infer<typeof pushPrefsSchema>;

/** One of my phones. Its push token never leaves the server. */
export const pushDeviceSchema = z.object({
  id: z.string(),
  platform: z.enum(PUSH_PLATFORMS),
  client_ref: z.string().nullable(),
  prefs: pushPrefsSchema,
  created_at: isoTime,
  last_seen_at: isoTime,
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

/** `enabled: false`: this deployment sends no pushes (the apps hide their push settings). */
export const pushDeviceListSchema = z.object({ devices: z.array(pushDeviceSchema), enabled: z.boolean() });
export type PushDeviceList = z.infer<typeof pushDeviceListSchema>;

/** Register or refresh this phone (sign-in, launch, back to the foreground, a new token). */
export const registerPushDeviceInputSchema = z.object({
  token: z.string().regex(EXPO_PUSH_TOKEN, { message: 'Use an Expo push token ("ExponentPushToken[…]").' }),
  platform: z.enum(PUSH_PLATFORMS),
  project_id: z.string().regex(PROJECT_ID, { message: "Use the app's Expo project id (a UUID)." }),
  client_ref: z
    .string()
    .regex(CLIENT_REF, { message: 'Use 1–64 characters of A-Z a-z 0-9 . _ : -' })
    .nullable()
    .optional(),
  prefs: pushPrefsSchema.partial().optional(),
});
export type RegisterPushDeviceInput = z.input<typeof registerPushDeviceInputSchema>;

/** `device: null, enabled: false`: pushes are off here and nothing was stored. */
export const pushDeviceRegisteredSchema = z.object({ device: pushDeviceSchema.nullable(), enabled: z.boolean() });
export type PushDeviceRegistered = z.infer<typeof pushDeviceRegisteredSchema>;

export const updatePushDeviceInputSchema = z.object({
  prefs: pushPrefsSchema
    .partial()
    .refine((prefs) => Object.keys(prefs).length > 0, { message: 'Send at least one switch.' }),
});
export type UpdatePushDeviceInput = z.input<typeof updatePushDeviceInputSchema>;

// ─── 管理 → 服务 → 渠道 (ADM-05) ──────────────────────────────────────────

/** The channels an admin sets up here; email is the mail capability (管理 → 服务 → 邮箱). */
export const ADMIN_CHANNELS = ['feishu', 'wecom', 'push'] as const;
export type AdminChannel = (typeof ADMIN_CHANNELS)[number];

const statusFields = {
  /** It can deliver now: set up, turned on, its keys filled in. */
  configured: z.boolean(),
  /** Where its settings come from; null before anything is set up. Env settings are read-only. */
  source: z.enum(['env', 'workspace']).nullable(),
  enabled: z.boolean(),
  /** Which write-only fields hold a value. The values never leave the server. */
  secrets_set: z.array(z.string()),
  /** The last notification it delivered. */
  last_success_at: isoTime.nullable(),
  /** The last delivery that failed (and will be retried, or gave up). */
  last_error: z.string().nullable(),
  last_error_at: isoTime.nullable(),
};

export const feishuChannelSettingsSchema = z.object({ base_url: z.string(), app_id: z.string() });
export const wecomChannelSettingsSchema = z.object({ base_url: z.string(), corp_id: z.string(), agent_id: z.number() });
export const pushChannelSettingsSchema = z.object({ base_url: z.string() });

export const channelStatusSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('feishu'), ...statusFields, settings: feishuChannelSettingsSchema.nullable() }),
  z.object({ channel: z.literal('wecom'), ...statusFields, settings: wecomChannelSettingsSchema.nullable() }),
  z.object({ channel: z.literal('push'), ...statusFields, settings: pushChannelSettingsSchema.nullable() }),
]);
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const adminChannelsSchema = z.object({ items: z.array(channelStatusSchema) });
export type AdminChannels = z.infer<typeof adminChannelsSchema>;

/** A pasted key or secret: one line, outer spaces dropped. */
const secretSchema = z
  .string()
  .trim()
  .max(4096)
  .refine((value) => !/[\r\n]/.test(value), { message: 'Use one line.' });
const baseUrlSchema = z.string().trim().url().max(500);

/**
 * Settings an admin saves for one channel. Write-only fields (app_secret, secret, access_token):
 * omitted keeps the stored value, '' clears it. A new base URL clears them too: a key never
 * follows its settings to another address.
 */
export const channelInputSchemas = {
  feishu: z
    .object({
      base_url: baseUrlSchema,
      app_id: z.string().trim().min(1).max(64),
      app_secret: secretSchema,
      enabled: z.boolean(),
    })
    .partial()
    .strict(),
  wecom: z
    .object({
      base_url: baseUrlSchema,
      corp_id: z.string().trim().min(1).max(64),
      agent_id: z.number().int().positive(),
      secret: secretSchema,
      enabled: z.boolean(),
    })
    .partial()
    .strict(),
  push: z.object({ base_url: baseUrlSchema, access_token: secretSchema, enabled: z.boolean() }).partial().strict(),
} as const;
export type ChannelInput = { [C in AdminChannel]: z.input<(typeof channelInputSchemas)[C]> };

/** A test message to the admin themself: their linked account, their phones. */
export const channelTestSchema = z.object({
  ok: z.boolean(),
  /** How many test messages went out; 0 when the keys work but there is nowhere of mine to send to. */
  delivered: z.number().int(),
  latency_ms: z.number().int(),
  error: z.string().nullable(),
});
export type ChannelTest = z.infer<typeof channelTestSchema>;
