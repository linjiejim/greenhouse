import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationError, type DatabaseProvider } from '@greenhouse/db';

const ws = vi.hoisted(() => ({ sendToUser: vi.fn() }));
vi.mock('../ws/connection-manager.js', () => ({ connectionManager: ws }));

import { publishNotification } from './publish.js';

const NOW = Date.parse('2026-10-10T08:00:00.000Z');
const ENVELOPE = { k: 'replies', sid: 'bots-dm-1', open: 'bots', message_id: 'msg-1' } as const;

function fact(over: Record<string, unknown> = {}) {
  return {
    id: 'ntf-1',
    user_id: 'owner-1',
    kind: 'bots_reply',
    title: 'Sage replied',
    run_id: null,
    interrupt_id: null,
    created_at: '2026-10-10T07:59:00.000Z',
    payload: JSON.stringify({ bots_session_id: 'bots-dm-1', push: ENVELOPE }),
    ...over,
  };
}

function dbWith(notifications: Record<string, unknown>, devices: unknown[] = []) {
  return {
    notifications: { countUnread: vi.fn().mockResolvedValue(2), createDelivery: vi.fn(), ...notifications },
    users: {
      getById: vi.fn().mockResolvedValue({ id: 'owner-1', status: 'active', role: 'team', auth_version: 3 }),
    },
    pushDevices: { listDeliverable: vi.fn().mockResolvedValue(devices) },
  } as unknown as DatabaseProvider & {
    notifications: { createDelivery: ReturnType<typeof vi.fn> };
    pushDevices: { listDeliverable: ReturnType<typeof vi.fn> };
  };
}

const input = {
  user_id: 'owner-1',
  kind: 'bots_reply' as const,
  title: 'Sage replied',
  body: 'Open the conversation to read it.',
  payload: { bots_session_id: 'bots-dm-1' },
  dedupe_key: 'bots-reply:bots-dm-1:msg-1',
  push: ENVELOPE,
};

describe('publishNotification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the fact with its push envelope, announces it, and queues one row per phone whose switch is on', async () => {
    const createWithStatus = vi.fn().mockResolvedValue({ created: true, notification: fact() });
    const devices = [
      { id: 'pdv_on', prefs: '{}' },
      { id: 'pdv_off', prefs: '{"replies":false}' },
    ];
    const db = dbWith({ createWithStatus }, devices);
    await publishNotification(db, input, { pushEnabled: true, now: () => NOW });

    expect(createWithStatus.mock.calls[0]![0].payload).toEqual({ bots_session_id: 'bots-dm-1', push: ENVELOPE });
    expect(ws.sendToUser).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ type: 'notification:new', notificationId: 'ntf-1', kind: 'bots_reply', unread: 2 }),
    );
    expect(db.pushDevices.listDeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner-1', auth_version: 3 }),
      NOW,
    );
    expect(db.notifications.createDelivery.mock.calls.map(([row]) => row)).toEqual([
      { notification_id: 'ntf-1', channel: 'mobile_push', recipient: 'pdv_on' },
    ]);
  });

  it('keeps the fact already written when a replay changed its wording, without announcing it twice', async () => {
    const createWithStatus = vi
      .fn()
      .mockRejectedValue(new NotificationError('notification_idempotency_conflict', 'reused'));
    const getByDedupeKey = vi.fn().mockResolvedValue(fact({ title: 'Sage 回复了你' }));
    const db = dbWith({ createWithStatus, getByDedupeKey }, [{ id: 'pdv_on', prefs: '{}' }]);
    const result = await publishNotification(db, input, { pushEnabled: true, now: () => NOW });

    expect(result).toEqual({ created: false, notification: expect.objectContaining({ title: 'Sage 回复了你' }) });
    expect(getByDedupeKey).toHaveBeenCalledWith('owner-1', 'bots-reply:bots-dm-1:msg-1');
    expect(ws.sendToUser).not.toHaveBeenCalled();
    // rows are idempotent per fact × phone: a replay heals a crash between the fact and its rows
    expect(db.notifications.createDelivery).toHaveBeenCalledTimes(1);
  });

  it('queues nothing for a fact stored without an envelope, or with pushes off', async () => {
    const old = vi.fn().mockResolvedValue({ created: false, notification: fact({ payload: '{}' }) });
    const db = dbWith({ createWithStatus: old }, [{ id: 'pdv_on', prefs: '{}' }]);
    await publishNotification(db, input, { pushEnabled: true, now: () => NOW });
    expect(db.notifications.createDelivery).not.toHaveBeenCalled();

    const fresh = dbWith({ createWithStatus: vi.fn().mockResolvedValue({ created: true, notification: fact() }) }, [
      { id: 'pdv_on', prefs: '{}' },
    ]);
    await publishNotification(fresh, input, { pushEnabled: false, now: () => NOW });
    expect(fresh.pushDevices.listDeliverable).not.toHaveBeenCalled();
    expect(fresh.notifications.createDelivery).not.toHaveBeenCalled();
  });

  it('rethrows any other failure (a Runtime projector retries its event)', async () => {
    const db = dbWith({ createWithStatus: vi.fn().mockRejectedValue(new Error('connection reset')) });
    await expect(publishNotification(db, input, { pushEnabled: true })).rejects.toThrow('connection reset');
  });
});
