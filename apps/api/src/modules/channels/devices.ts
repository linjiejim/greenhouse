/**
 * Phones that receive pushes (`push_devices`). Registering is an upsert by token, one token at a
 * time: the same phone signing in again refreshes its row and keeps its switches; signing in as
 * someone else moves the row to them with fresh switches. Rows are never deleted: unregistering,
 * Expo's DeviceNotRegistered and the per-member cap only disable them, and registering again
 * brings one back.
 *
 * Whether a phone may get a push is decided in one place (`deliverable`): enabled, registered
 * under the member's current auth_version (a password change or a disable stops it until the app
 * signs in again), and seen in the last 90 days.
 */

import { and, asc, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { PushDevice, PushPrefs, RegisterPushDeviceInput } from '@greenhouse/contract';
import { getDb, newId, pushDevices, transaction, type PushDeviceRow, type PushDisabledReason } from '@greenhouse/db';

export const PUSH_DEVICE_STALE_MS = 90 * 24 * 60 * 60 * 1000;
/** Active phones one member may keep; one more retires the one seen least recently. */
export const MAX_ACTIVE_PUSH_DEVICES = 10;

/** A phone's switches only narrow the member's settings, so by default they narrow nothing. */
export const DEFAULT_PUSH_PREFS: PushPrefs = {
  needs_you: true,
  done: true,
  replies: true,
  preview: true,
  live_activity: false,
};

/** The stored switches, completed with the defaults (stored values of the wrong type are ignored). */
export function prefsOf(row: Pick<PushDeviceRow, 'prefs'>): PushPrefs {
  const prefs = { ...DEFAULT_PUSH_PREFS };
  for (const key of Object.keys(prefs) as (keyof PushPrefs)[]) {
    const value = row.prefs?.[key];
    if (typeof value === 'boolean') prefs[key] = value;
  }
  return prefs;
}

export const toPushDevice = (row: PushDeviceRow): PushDevice => ({
  id: row.id,
  platform: row.platform,
  client_ref: row.clientRef,
  prefs: prefsOf(row),
  created_at: row.createdAt,
  last_seen_at: row.lastSeenAt,
});

const stale = () => new Date(Date.now() - PUSH_DEVICE_STALE_MS).toISOString();

/** Upsert by token: the row now registered to this member. */
export async function registerDevice(
  member: { id: string; authVersion: number },
  input: RegisterPushDeviceInput,
): Promise<PushDeviceRow> {
  return transaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`push-device:${input.token}`}, 0))`);
    const [existing] = await db.select().from(pushDevices).where(eq(pushDevices.token, input.token));
    const sameMember = existing?.memberId === member.id;
    // Someone else on the same phone starts from the defaults, not the previous member's choices.
    const prefs = { ...(existing && sameMember ? existing.prefs : {}), ...input.prefs };
    const values = {
      memberId: member.id,
      platform: input.platform,
      projectId: input.project_id.toLowerCase(),
      clientRef: input.client_ref ?? null,
      prefs,
      authVersion: member.authVersion,
      lastSeenAt: sql`now()`,
      disabledAt: null,
      disabledReason: null,
      updatedAt: sql`now()`,
    };
    const [device] = existing
      ? await db
          .update(pushDevices)
          .set({ ...values, ...(sameMember ? {} : { createdAt: sql`now()` }) })
          .where(eq(pushDevices.id, existing.id))
          .returning()
      : await db
          .insert(pushDevices)
          .values({ id: newId('pushDevice'), token: input.token, ...values })
          .returning();

    // Bound one member's fan-out: past the cap, the phones seen least recently retire.
    const others = await db
      .select({ id: pushDevices.id })
      .from(pushDevices)
      .where(and(eq(pushDevices.memberId, member.id), isNull(pushDevices.disabledAt), ne(pushDevices.id, device!.id)))
      .orderBy(desc(pushDevices.lastSeenAt), desc(pushDevices.id));
    for (const surplus of others.slice(MAX_ACTIVE_PUSH_DEVICES - 1)) await disableDevice(surplus.id, 'device_limit');
    return device!;
  });
}

/** The member's enabled phones, most recently seen first. */
export async function activeDevices(memberId: string): Promise<PushDeviceRow[]> {
  return getDb()
    .select()
    .from(pushDevices)
    .where(and(eq(pushDevices.memberId, memberId), isNull(pushDevices.disabledAt)))
    .orderBy(desc(pushDevices.lastSeenAt), asc(pushDevices.id));
}

/** The phones a push for this member may go to now. */
export async function deliverableDevices(member: { id: string; authVersion: number }): Promise<PushDeviceRow[]> {
  return getDb()
    .select()
    .from(pushDevices)
    .where(
      and(
        eq(pushDevices.memberId, member.id),
        isNull(pushDevices.disabledAt),
        eq(pushDevices.authVersion, member.authVersion),
        gte(pushDevices.lastSeenAt, stale()),
      ),
    )
    .orderBy(asc(pushDevices.createdAt), asc(pushDevices.id));
}

export async function ownDevice(memberId: string, id: string): Promise<PushDeviceRow | null> {
  const [row] = await getDb()
    .select()
    .from(pushDevices)
    .where(and(eq(pushDevices.id, id), eq(pushDevices.memberId, memberId)));
  return row ?? null;
}

/** Changes some switches of the member's own enabled phone; null when it is not theirs or disabled. */
export async function updatePrefs(
  memberId: string,
  id: string,
  change: Partial<PushPrefs>,
): Promise<PushDeviceRow | null> {
  const [row] = await getDb()
    .update(pushDevices)
    .set({ prefs: sql`${pushDevices.prefs} || ${JSON.stringify(change)}::jsonb`, updatedAt: sql`now()` })
    .where(and(eq(pushDevices.id, id), eq(pushDevices.memberId, memberId), isNull(pushDevices.disabledAt)))
    .returning();
  return row ?? null;
}

/** Idempotent: a phone already disabled keeps its first reason. */
export async function disableDevice(id: string, reason: PushDisabledReason): Promise<void> {
  await getDb()
    .update(pushDevices)
    .set({ disabledAt: sql`now()`, disabledReason: reason, updatedAt: sql`now()` })
    .where(and(eq(pushDevices.id, id), isNull(pushDevices.disabledAt)));
}
