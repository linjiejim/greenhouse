/**
 * Mobile push devices — the recipients of the `mobile_push` delivery channel
 * (docs/specs/20261010-mobile-push.md §3.2–§3.4).
 *
 * Registration is an upsert by token, serialised per token: the same phone
 * signing in again refreshes its row; signing in as someone else moves the row
 * to the new account with fresh prefs. Nothing is ever hard-deleted —
 * unregistering only disables a row, and registering the token again revives
 * it with the prefs it had.
 *
 * "Deliverable" is decided in one place (`isDeliverable`, also used by the
 * delivery worker's re-check): enabled, registered under the account's current
 * credential generation, and seen in the last 90 days.
 */

import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import { normalizePushPrefs, type PushPrefs } from '@greenhouse/types/push';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { pushDevices } from '../schema/index.js';
import type { PushDeviceDisabledReason, PushDeviceRow } from '../schema/push-device.js';

/** A device not refreshed for this long gets nothing (spec R4). */
export const PUSH_DEVICE_STALE_MS = 90 * 24 * 60 * 60 * 1000;

/** Active devices one account may keep; registering one more retires the least recently seen. */
export const MAX_ACTIVE_PUSH_DEVICES = 10;

export interface RegisterPushDeviceInput {
  user_id: string;
  token: string;
  platform: PushDeviceRow['platform'];
  project_id: string;
  client_ref: string | null;
  /** Merged over the stored prefs (same account) or the defaults (new row / another account). */
  prefs?: Partial<PushPrefs>;
  /** `users.auth_version` right now. */
  auth_version: number;
  /** When the phone checked in (default now) — `created_at` / `last_seen_at`. */
  at?: string | Date;
}

function newDeviceId(): string {
  return `pdv_${randomBytes(8).toString('hex')}`;
}

/** The row's prefs, complete (stored JSON is never trusted to be). */
export function pushDevicePrefs(row: Pick<PushDeviceRow, 'prefs'>): PushPrefs {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.prefs);
  } catch {
    // A broken value reads as the defaults.
  }
  return normalizePushPrefs(parsed);
}

/**
 * Whether a device may receive a push for `user` now. The delivery worker asks
 * again right before sending, so a reset password, a sign-out on the phone or a
 * different account on it stops the pushes that were already queued.
 */
export function isDeliverable(
  device: Pick<PushDeviceRow, 'user_id' | 'auth_version' | 'disabled_at' | 'last_seen_at'>,
  user: { id: string; auth_version: number },
  now: number = Date.now(),
): boolean {
  return (
    device.disabled_at === null &&
    device.user_id === user.id &&
    device.auth_version === user.auth_version &&
    Date.parse(device.last_seen_at) >= now - PUSH_DEVICE_STALE_MS
  );
}

export function createPushDeviceService(db: Db) {
  const service = {
    /** Upsert by token → the row now registered to `user_id`, and whether it was new to this account. */
    async register(input: RegisterPushDeviceInput): Promise<{ device: PushDeviceRow; created: boolean }> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`push-device:${input.token}`}, 0))`);
        const now = input.at === undefined ? nowIso() : new Date(input.at).toISOString();
        const [existing] = await tx.select().from(pushDevices).where(eq(pushDevices.token, input.token)).limit(1);
        let device: PushDeviceRow;
        let created: boolean;
        if (!existing) {
          created = true;
          [device] = (await tx
            .insert(pushDevices)
            .values({
              id: newDeviceId(),
              user_id: input.user_id,
              token: input.token,
              platform: input.platform,
              project_id: input.project_id,
              client_ref: input.client_ref,
              prefs: JSON.stringify(normalizePushPrefs(input.prefs ?? {})),
              auth_version: input.auth_version,
              created_at: now,
              last_seen_at: now,
            })
            .returning()) as [PushDeviceRow];
        } else {
          const sameAccount = existing.user_id === input.user_id;
          // Another account on the same phone starts from the defaults, not the previous member's choices.
          const base = sameAccount ? pushDevicePrefs(existing) : undefined;
          created = !sameAccount;
          [device] = (await tx
            .update(pushDevices)
            .set({
              user_id: input.user_id,
              platform: input.platform,
              project_id: input.project_id,
              client_ref: input.client_ref,
              prefs: JSON.stringify(normalizePushPrefs(input.prefs ?? {}, base)),
              auth_version: input.auth_version,
              last_seen_at: now,
              disabled_at: null,
              disabled_reason: null,
              ...(sameAccount ? {} : { created_at: now }),
            })
            .where(eq(pushDevices.id, existing.id))
            .returning()) as [PushDeviceRow];
        }

        // Bound one account's fan-out: past the cap, the least recently seen devices retire.
        const active = await tx
          .select({ id: pushDevices.id })
          .from(pushDevices)
          .where(
            and(eq(pushDevices.user_id, input.user_id), isNull(pushDevices.disabled_at), ne(pushDevices.id, device.id)),
          )
          .orderBy(desc(pushDevices.last_seen_at), desc(pushDevices.id));
        const surplus = active.slice(MAX_ACTIVE_PUSH_DEVICES - 1);
        for (const row of surplus) {
          await tx
            .update(pushDevices)
            .set({ disabled_at: now, disabled_reason: 'device_limit' })
            .where(eq(pushDevices.id, row.id));
        }
        return { device, created };
      });
    },

    /** Internal lookup (the delivery worker). */
    async get(id: string): Promise<PushDeviceRow | undefined> {
      const [row] = await db.select().from(pushDevices).where(eq(pushDevices.id, id)).limit(1);
      return row;
    },

    async getForUser(userId: string, id: string): Promise<PushDeviceRow | undefined> {
      const [row] = await db
        .select()
        .from(pushDevices)
        .where(and(eq(pushDevices.id, id), eq(pushDevices.user_id, userId)))
        .limit(1);
      return row;
    },

    /** The account's enabled devices, most recently seen first. */
    async listActiveForUser(userId: string): Promise<PushDeviceRow[]> {
      return db
        .select()
        .from(pushDevices)
        .where(and(eq(pushDevices.user_id, userId), isNull(pushDevices.disabled_at)))
        .orderBy(desc(pushDevices.last_seen_at), asc(pushDevices.id));
    },

    /** The devices a new push for this account fans out to (`isDeliverable`, in SQL). */
    async listDeliverable(
      user: { id: string; auth_version: number },
      now: number = Date.now(),
    ): Promise<PushDeviceRow[]> {
      return db
        .select()
        .from(pushDevices)
        .where(
          and(
            eq(pushDevices.user_id, user.id),
            isNull(pushDevices.disabled_at),
            eq(pushDevices.auth_version, user.auth_version),
            gte(pushDevices.last_seen_at, new Date(now - PUSH_DEVICE_STALE_MS).toISOString()),
          ),
        )
        .orderBy(asc(pushDevices.created_at), asc(pushDevices.id));
    },

    /** Change some prefs of the member's own enabled device (undefined = not theirs / disabled). */
    async updatePrefs(userId: string, id: string, prefs: Partial<PushPrefs>): Promise<PushDeviceRow | undefined> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(pushDevices)
          .where(and(eq(pushDevices.id, id), eq(pushDevices.user_id, userId), isNull(pushDevices.disabled_at)))
          .limit(1)
          .for('update');
        if (!row) return undefined;
        const [updated] = await tx
          .update(pushDevices)
          .set({ prefs: JSON.stringify(normalizePushPrefs(prefs, pushDevicePrefs(row))) })
          .where(eq(pushDevices.id, row.id))
          .returning();
        return updated;
      });
    },

    /** The member unregisters one of their devices (sign-out, station removed, pushes off). False = not theirs. */
    async unregister(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .update(pushDevices)
        .set({ disabled_at: nowIso(), disabled_reason: 'unregistered' })
        .where(and(eq(pushDevices.id, id), eq(pushDevices.user_id, userId), isNull(pushDevices.disabled_at)))
        .returning({ id: pushDevices.id });
      if (rows.length > 0) return true;
      // Already disabled is still theirs: unregistering twice is not an error.
      return Boolean(await service.getForUser(userId, id));
    },

    /** The transport says this token is dead (Expo `DeviceNotRegistered`). */
    async disable(id: string, reason: PushDeviceDisabledReason): Promise<void> {
      await db
        .update(pushDevices)
        .set({ disabled_at: nowIso(), disabled_reason: reason })
        .where(and(eq(pushDevices.id, id), isNull(pushDevices.disabled_at)));
    },
  };
  return service;
}

export type PushDeviceService = ReturnType<typeof createPushDeviceService>;
