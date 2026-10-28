import { afterEach, beforeEach, expect, it } from 'vitest';
import { initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { registerNotificationKinds, registerNotificationChannels } from '@greenhouse/types/notification';
import { createInternalTestUser } from '../helpers/internal-user.js';
let db: DatabaseProvider;
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  registerNotificationKinds(['ext:fixture:ready']);
  registerNotificationChannels(['fixture']);
});
afterEach(() => {
  registerNotificationKinds([]);
  registerNotificationChannels([]);
});
it('validates active plugin kinds/channels before writing, preserving historical reads after disablement', async () => {
  const user = await createInternalTestUser(db, { email: 'notification-registry@test.local' });
  const notification = await db.notifications.create({
    user_id: user.id,
    kind: 'ext:fixture:ready',
    title: 'Ready',
    body: 'Fixture ready',
    dedupe_key: 'fixture:1',
  });
  const delivery = await db.notifications.createDelivery({
    notification_id: notification.id,
    channel: 'fixture',
    recipient: 'fixture:user:1',
  });
  expect(delivery.channel).toBe('fixture');
  expect(await db.notifications.claimDeliveries({ worker_id: 'empty', lease_ms: 1000, channels: [] })).toEqual([]);
  expect(
    await db.notifications.claimDeliveries({ worker_id: 'push-only', lease_ms: 1000, channels: ['mobile_push'] }),
  ).toEqual([]);
  expect(
    (await db.notifications.claimDeliveries({ worker_id: 'fixture', lease_ms: 1000, channels: ['fixture'] })).map(
      (d) => d.id,
    ),
  ).toEqual([delivery.id]);
  registerNotificationKinds([]);
  registerNotificationChannels([]);
  expect((await db.notifications.get(notification.id))?.kind).toBe('ext:fixture:ready');
  await expect(
    db.notifications.create({
      user_id: user.id,
      kind: 'ext:fixture:ready',
      title: 'Ready',
      body: 'Disabled',
      dedupe_key: 'fixture:2',
    }),
  ).rejects.toMatchObject({ code: 'notification_invalid_input' });
  await expect(
    db.notifications.createDelivery({
      notification_id: notification.id,
      channel: 'fixture',
      recipient: 'fixture:user:2',
    }),
  ).rejects.toMatchObject({ code: 'notification_invalid_input' });
});
