/**
 * Mobile push devices (docs/specs/20261010-mobile-push.md §3.2): registration is an
 * upsert by token — the same phone refreshes its row, another account takes it over
 * with fresh prefs; unregistering only disables; "deliverable" means enabled, current
 * credential generation and seen in the last 90 days; one account keeps at most
 * MAX_ACTIVE_PUSH_DEVICES enabled devices.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  isDeliverable,
  MAX_ACTIVE_PUSH_DEVICES,
  PUSH_DEVICE_STALE_MS,
  pushDevicePrefs,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { DEFAULT_PUSH_PREFS } from '@greenhouse/types/push';

import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let other: UserRow;

const PROJECT = '1f49365d-7d88-472a-b196-01fcd9c428e5';

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function token(): string {
  return `ExponentPushToken[${unique('t')}]`;
}

function register(user: UserRow, overrides: Partial<Parameters<DatabaseProvider['pushDevices']['register']>[0]> = {}) {
  return db.pushDevices.register({
    user_id: user.id,
    token: token(),
    platform: 'ios',
    project_id: PROJECT,
    client_ref: 'st-home',
    auth_version: user.auth_version,
    ...overrides,
  });
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  owner = await createInternalTestUser(db, { email: `${unique('push-owner')}@test.local` });
  other = await createInternalTestUser(db, { email: `${unique('push-other')}@test.local` });
});

afterEach(() => {
  _resetProvider();
});

describe('push device registration', () => {
  it('creates a row with the default prefs, then refreshes the same row for the same phone', async () => {
    const t = token();
    const first = await register(owner, { token: t });
    expect(first.created).toBe(true);
    expect(first.device).toMatchObject({ user_id: owner.id, token: t, platform: 'ios', client_ref: 'st-home' });
    expect(pushDevicePrefs(first.device)).toEqual(DEFAULT_PUSH_PREFS);

    await db.pushDevices.updatePrefs(owner.id, first.device.id, { replies: false });
    const again = await register(owner, { token: t, client_ref: 'st-work', prefs: { preview: true } });
    expect(again.created).toBe(false);
    expect(again.device.id).toBe(first.device.id);
    expect(again.device.client_ref).toBe('st-work');
    // stored choices survive a re-registration; the request's prefs are merged on top
    expect(pushDevicePrefs(again.device)).toEqual({ ...DEFAULT_PUSH_PREFS, replies: false, preview: true });
    expect(Date.parse(again.device.last_seen_at)).toBeGreaterThanOrEqual(Date.parse(first.device.last_seen_at));
  });

  it('moves the phone to another account with fresh prefs; the previous account stops reaching it', async () => {
    const t = token();
    const mine = await register(owner, { token: t, prefs: { preview: true } });
    const theirs = await register(other, { token: t });
    expect(theirs.created).toBe(true);
    expect(theirs.device.id).toBe(mine.device.id);
    expect(theirs.device.user_id).toBe(other.id);
    expect(pushDevicePrefs(theirs.device)).toEqual(DEFAULT_PUSH_PREFS);
    expect((await db.pushDevices.listDeliverable(owner)).map((d) => d.id)).not.toContain(mine.device.id);
    expect((await db.pushDevices.listDeliverable(other)).map((d) => d.id)).toContain(mine.device.id);
    expect(await db.pushDevices.getForUser(owner.id, mine.device.id)).toBeUndefined();
  });

  it('unregistering disables the row (twice is fine, someone else’s is not theirs) and registering revives it', async () => {
    const t = token();
    const { device } = await register(owner, { token: t, prefs: { done: false } });
    expect(await db.pushDevices.unregister(other.id, device.id)).toBe(false);
    expect(await db.pushDevices.unregister(owner.id, device.id)).toBe(true);
    expect(await db.pushDevices.unregister(owner.id, device.id)).toBe(true);
    const disabled = await db.pushDevices.get(device.id);
    expect(disabled).toMatchObject({ disabled_reason: 'unregistered' });
    expect(disabled?.disabled_at).not.toBeNull();
    expect(await db.pushDevices.listDeliverable(owner)).toEqual([]);
    // a disabled device takes no prefs changes
    expect(await db.pushDevices.updatePrefs(owner.id, device.id, { done: true })).toBeUndefined();

    const revived = await register(owner, { token: t });
    expect(revived.device.id).toBe(device.id);
    expect(revived.device.disabled_at).toBeNull();
    expect(pushDevicePrefs(revived.device).done).toBe(false);
  });

  it('only delivers to devices registered under the current credential generation and seen in 90 days', async () => {
    const fresh = await register(owner);
    const old = await register(owner, { auth_version: owner.auth_version - 1 });
    const stale = await register(owner, { at: Date.now() - PUSH_DEVICE_STALE_MS - 60_000 });

    const deliverable = (await db.pushDevices.listDeliverable(owner)).map((d) => d.id);
    expect(deliverable).toEqual([fresh.device.id]);
    expect(isDeliverable(fresh.device, owner)).toBe(true);
    expect(isDeliverable(old.device, owner)).toBe(false);
    expect(isDeliverable(stale.device, owner)).toBe(false);
    expect(isDeliverable(fresh.device, { id: other.id, auth_version: owner.auth_version })).toBe(false);
    // a password reset bumps the generation: the device needs a new sign-in
    expect(isDeliverable(fresh.device, { id: owner.id, auth_version: owner.auth_version + 1 })).toBe(false);
  });

  it('keeps one account to the cap by retiring the least recently seen devices', async () => {
    const devices = [];
    // the first one checked in a minute earlier than the rest: the least recently seen
    for (let i = 0; i < MAX_ACTIVE_PUSH_DEVICES; i++) {
      devices.push((await register(owner, i === 0 ? { at: Date.now() - 60_000 } : {})).device);
    }
    const extra = await register(owner);
    const active = await db.pushDevices.listActiveForUser(owner.id);
    expect(active).toHaveLength(MAX_ACTIVE_PUSH_DEVICES);
    expect(active.map((d) => d.id)).toContain(extra.device.id);
    expect(await db.pushDevices.get(devices[0]!.id)).toMatchObject({ disabled_reason: 'device_limit' });
    // the other account is untouched
    expect(await db.pushDevices.listActiveForUser(other.id)).toEqual([]);
  });

  it('records a transport verdict without touching an already disabled row', async () => {
    const { device } = await register(owner);
    await db.pushDevices.disable(device.id, 'device_not_registered');
    expect(await db.pushDevices.get(device.id)).toMatchObject({ disabled_reason: 'device_not_registered' });
    await db.pushDevices.disable(device.id, 'device_limit');
    expect(await db.pushDevices.get(device.id)).toMatchObject({ disabled_reason: 'device_not_registered' });
  });

  it('changes prefs only on the member’s own enabled device, merging over what was stored', async () => {
    const { device } = await register(owner, { prefs: { preview: true } });
    expect(await db.pushDevices.updatePrefs(other.id, device.id, { needs_you: false })).toBeUndefined();
    const updated = await db.pushDevices.updatePrefs(owner.id, device.id, { needs_you: false });
    expect(pushDevicePrefs(updated!)).toEqual({ ...DEFAULT_PUSH_PREFS, needs_you: false, preview: true });
  });
});
