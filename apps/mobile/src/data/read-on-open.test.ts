import { describe, expect, it, vi } from 'vitest';
import type { PlatformNotification } from '../shared/greenhouse-types';
import { readOnOpen } from './read-on-open';

const note = (read: boolean): PlatformNotification => ({
  id: 'ntf_1',
  user_id: 'u1',
  kind: 'system',
  title: 'T',
  body: 'B',
  payload: {},
  run_id: null,
  interrupt_id: null,
  event_id: null,
  agent_id: null,
  read_at: read ? '2026-10-23T00:00:00.000Z' : null,
  created_at: '2026-10-23T00:00:00.000Z',
});

function deps(over: Partial<Parameters<typeof readOnOpen>[1]> = {}) {
  return {
    known: undefined,
    markRead: vi.fn(async () => true),
    fetchByReading: vi.fn(async () => note(true)),
    clearBanner: vi.fn(),
    reportFailure: vi.fn(),
    ...over,
  };
}

describe('opening a notification', () => {
  it('reads a listed one, then clears its banner', async () => {
    const d = deps({ known: note(false) });
    expect(await readOnOpen('ntf_1', d)).toMatchObject({ read: true });
    expect(d.markRead).toHaveBeenCalledWith('ntf_1');
    expect(d.clearBanner).toHaveBeenCalledWith('ntf_1');
    expect(d.reportFailure).not.toHaveBeenCalled();
  });

  it('keeps the banner and tells the member when the read does not reach the server', async () => {
    const d = deps({ known: note(false), markRead: vi.fn(async () => false) });
    expect(await readOnOpen('ntf_1', d)).toMatchObject({ read: false });
    expect(d.clearBanner).not.toHaveBeenCalled();
    expect(d.reportFailure).toHaveBeenCalledOnce();
  });

  it('only clears the banner of one already read', async () => {
    const d = deps({ known: note(true) });
    await readOnOpen('ntf_1', d);
    expect(d.markRead).not.toHaveBeenCalled();
    expect(d.clearBanner).toHaveBeenCalledOnce();
  });

  it('fetches one the list does not have by reading it; nothing found keeps the banner', async () => {
    const found = deps();
    expect(await readOnOpen('ntf_1', found)).toMatchObject({ read: true, notification: { id: 'ntf_1' } });
    expect(found.clearBanner).toHaveBeenCalledOnce();
    const missing = deps({ fetchByReading: vi.fn(async () => null) });
    expect(await readOnOpen('ntf_1', missing)).toEqual({ notification: null, read: false });
    expect(missing.clearBanner).not.toHaveBeenCalled();
  });
});
