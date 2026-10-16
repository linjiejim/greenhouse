import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, notifications } from '@greenhouse/db';
import { createHub } from '../../../realtime/hub.js';
import { createNotificationsService } from '../service.js';

describe('publishing a notification', () => {
  it('keeps it, and tells the open screens, even when its deliveries cannot be queued', async () => {
    let woken = 0;
    const hub = createHub();
    const events: string[] = [];
    hub.subscribe('mbr_lin', (event) => events.push(event.type));
    const service = createNotificationsService({
      hub,
      deliveries: {
        // A failing statement, as a broken delivery setup would raise.
        enqueue: async () => {
          await getDb().execute(sql`select * from no_such_table`);
        },
        wake: () => woken++,
      },
    });
    const published = await service.publish({
      memberId: 'mbr_lin',
      kind: 'system',
      title: 'Hello',
      dedupeKey: 'hello',
    });
    expect(published).toMatchObject({ kind: 'system', title: 'Hello' });
    expect(await getDb().select().from(notifications).where(eq(notifications.memberId, 'mbr_lin'))).toHaveLength(1);
    expect(events).toEqual(['notification.created']);
    expect(woken).toBe(1);
    // Once per member and dedupe key.
    expect(
      await service.publish({ memberId: 'mbr_lin', kind: 'system', title: 'Hello', dedupeKey: 'hello' }),
    ).toBeNull();
  });
});
