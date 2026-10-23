/**
 * Whether a notification fact becomes a push on one phone, and for how long it
 * may still arrive. Pure: `queueMobilePush` asks once per phone when the fact is
 * written, the delivery worker asks again right before sending (the phone's
 * switches and the clock may have moved on).
 *
 * - The category comes from the notification's kind (`pushCategoryOf`); the
 *   phone's switch for that category can turn it off.
 * - A push never outlives its news: a day after the fact was written it is
 *   dropped instead of sent.
 * - Something that waits for the member may break through Focus (time-sensitive).
 */

import { pushCategoryOf, type PushCategory, type PushPrefs } from '@greenhouse/types/push';

/** A push that could not be delivered within a day is no longer news. */
export const PUSH_TTL_MS = 24 * 60 * 60 * 1000;

export type PushDecision =
  | { push: false; reason: 'category_off' | 'expired' }
  | {
      push: true;
      category: PushCategory;
      /** Epoch ms after which the push must not arrive (APNs `expiration`). */
      expiresAt: number;
      interruptionLevel: 'time-sensitive' | 'active';
      /** Notification Center groups banners by category. */
      threadId: string;
    };

export function pushPolicy(input: {
  /** The notification's kind. */
  kind: string;
  prefs: PushPrefs;
  /** The fact's `created_at`. */
  createdAt: string;
  now: number;
}): PushDecision {
  const category = pushCategoryOf(input.kind);
  if (!input.prefs[category]) return { push: false, reason: 'category_off' };
  const created = Date.parse(input.createdAt);
  const expiresAt = (Number.isFinite(created) ? created : input.now) + PUSH_TTL_MS;
  if (expiresAt <= input.now) return { push: false, reason: 'expired' };
  return {
    push: true,
    category,
    expiresAt,
    interruptionLevel: input.kind === 'runtime_attention' ? 'time-sensitive' : 'active',
    threadId: `greenhouse:${category}`,
  };
}
