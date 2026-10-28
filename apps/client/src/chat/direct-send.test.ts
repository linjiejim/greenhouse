import { describe, expect, it, vi } from 'vitest';
import type { SendResult } from '../data/conversation';
import { sendDirect, type DirectSendEffects } from './direct-send';

const offline: SendResult = { sent: false, restore: 'Hello', notice: 'offline', message: '', status: 0 };

function effects(queueOk = true) {
  return {
    queue: vi.fn(() => queueOk),
    setOffline: vi.fn(),
    restoreDraft: vi.fn(),
    alert: vi.fn(),
  } satisfies DirectSendEffects;
}
const turn = (result: SendResult, stillCurrent = () => true) => ({
  send: vi.fn(async () => result),
  stillCurrent,
  sessionId: 'ses_1',
  text: 'Hello',
  images: [{ id: 'img', url: 'u' }],
  turnId: 'q-abc-123456',
});

describe('a composer send', () => {
  it('queues an unanswered send under the turn id it was sent with', async () => {
    const fx = effects();
    const t = turn(offline);
    expect(await sendDirect(t, fx)).toBe(false);
    expect(t.send).toHaveBeenCalledWith('q-abc-123456');
    expect(fx.queue).toHaveBeenCalledWith({ id: 'q-abc-123456', sessionId: 'ses_1', text: 'Hello', images: [{ id: 'img', url: 'u' }], status: 'unknown' });
    expect(fx.restoreDraft).not.toHaveBeenCalled();
  });

  it('drops a late failure once another member is signed in', async () => {
    const fx = effects();
    expect(await sendDirect(turn(offline, () => false), fx)).toBe(false);
    expect(await sendDirect(turn({ ...offline, notice: 'failed', status: 500 }, () => false), fx)).toBe(false);
    expect(fx.queue).not.toHaveBeenCalled();
    expect(fx.restoreDraft).not.toHaveBeenCalled();
    expect(fx.alert).not.toHaveBeenCalled();
    expect(fx.setOffline).not.toHaveBeenCalled();
  });

  it('gives the words back when the outbox is full or the station refused', async () => {
    const full = effects(false);
    await sendDirect(turn(offline), full);
    expect(full.restoreDraft).toHaveBeenCalledWith('Hello');
    expect(full.alert).toHaveBeenCalledWith('full');
    const busy = effects();
    await sendDirect(turn({ ...offline, notice: 'busy', status: 409, message: 'busy' }), busy);
    expect(busy.queue).not.toHaveBeenCalled();
    expect(busy.alert).toHaveBeenCalledWith('busy', 'busy');
  });
});
