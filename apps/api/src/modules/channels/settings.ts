/**
 * A member's delivery settings (设置 → 通知): per category, which channels besides in-app carry a
 * notification, and whether pushes and messages may name their subject. Pure: the defaults, the
 * merge of what a member saved, and which category a notification kind falls in.
 */

import {
  DELIVERY_CHANNELS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  type DeliveryChannel,
  type NotificationCategory,
  type NotificationKind,
  type NotificationSettings,
} from '@greenhouse/db';

const CATEGORY_OF: Record<NotificationKind, NotificationCategory> = {
  request: 'needs_you',
  reply: 'replies',
  mention: 'replies',
  run_done: 'runs',
  run_failed: 'runs',
  automation: 'other',
  comment: 'other',
  share: 'other',
  skill_scan: 'other',
  budget: 'other',
  system: 'other',
};

export const categoryOf = (kind: NotificationKind): NotificationCategory => CATEGORY_OF[kind];

export const kindsOf = (category: NotificationCategory): NotificationKind[] =>
  NOTIFICATION_KINDS.filter((kind) => CATEGORY_OF[kind] === category);

/**
 * Email starts off: every member has an address, so nothing goes there until they ask for it.
 * Pushes follow the phone apps (needs you, replies, finished runs). A Feishu or WeCom account was
 * linked to be reached there: what needs the member and finished runs.
 */
export const DEFAULT_CHANNELS: Readonly<Record<NotificationCategory, Readonly<Record<DeliveryChannel, boolean>>>> = {
  needs_you: { email: false, feishu: true, wecom: true, push: true },
  replies: { email: false, feishu: false, wecom: false, push: true },
  runs: { email: false, feishu: true, wecom: true, push: true },
  other: { email: false, feishu: false, wecom: false, push: false },
};

/** What a needs-you card asks and what a reply says never leave the server, previews or not. */
export const SENSITIVE: ReadonlySet<NotificationCategory> = new Set(['needs_you', 'replies']);

/**
 * Mentions wait a minute: a member who reads the conversation in the app meanwhile gets nothing
 * more. A reply is only written down once the member missed it for a minute, so it goes at once.
 */
export const deliveryDelayMs = (kind: NotificationKind): number => (kind === 'mention' ? 60_000 : 0);

/** Notifications from the same source and category within this window make one message per channel. */
export const COLLAPSE_WINDOW_MS = 5 * 60_000;

export interface EffectiveSettings {
  categories: Record<NotificationCategory, Record<DeliveryChannel, boolean>>;
  previews: boolean;
}

/** The defaults, with what the member saved on top. Stored values of the wrong type are ignored. */
export function effectiveSettings(stored: NotificationSettings | null | undefined): EffectiveSettings {
  const categories = {} as EffectiveSettings['categories'];
  for (const category of NOTIFICATION_CATEGORIES) {
    const saved = stored?.categories?.[category] ?? {};
    categories[category] = Object.fromEntries(
      DELIVERY_CHANNELS.map((channel) => {
        const value = saved[channel];
        return [channel, typeof value === 'boolean' ? value : DEFAULT_CHANNELS[category][channel]];
      }),
    ) as Record<DeliveryChannel, boolean>;
  }
  return { categories, previews: stored?.previews === true };
}

/** A member's change merged into what they had saved: fields left out keep their value. */
export function mergeSettings(
  stored: NotificationSettings | null | undefined,
  change: {
    categories?: Partial<Record<NotificationCategory, Partial<Record<DeliveryChannel, boolean>>>>;
    previews?: boolean;
  },
): NotificationSettings {
  const categories: NonNullable<NotificationSettings['categories']> = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    const merged = { ...stored?.categories?.[category], ...change.categories?.[category] };
    if (Object.keys(merged).length) categories[category] = merged;
  }
  return { categories, previews: change.previews ?? stored?.previews === true };
}
