import { describe, expect, it } from 'vitest';
import type { PlatformNotification } from '../shared/greenhouse-types';
import {
  parseSnapshot,
  SNAPSHOT_MAX,
  toSnapshot,
  withAllRead,
  withFirstPage,
  withItem,
  withNextPage,
  withRead,
} from './notifications';

function note(n: number, read = false): PlatformNotification {
  return {
    id: `ntf_${String(n).padStart(3, '0')}`,
    user_id: 'u1',
    kind: 'system',
    title: `Title ${n}`,
    body: `Body ${n}`,
    payload: {},
    run_id: null,
    interrupt_id: null,
    event_id: null,
    agent_id: null,
    read_at: read ? '2026-10-23T00:00:00.000Z' : null,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
  };
}

const ids = (items: readonly PlatformNotification[]) => items.map((item) => item.id);

describe('pages', () => {
  it('a fresh first page replaces what it covers and keeps older items loaded beyond it', () => {
    const shown = [note(9), note(8), note(7), note(3), note(2)];
    const page = [note(10), note(9, true), note(7)];
    const merged = withFirstPage(shown, page);
    expect(ids(merged)).toEqual(ids([note(10), note(9), note(7), note(3), note(2)]));
    expect(merged[1]!.read_at).not.toBeNull();
    // an item inside the page's range but gone from it was deleted: dropped
    expect(ids(merged)).not.toContain(note(8).id);
    expect(withFirstPage(shown, [])).toEqual([]);
  });

  it('appends a later page without duplicates', () => {
    expect(ids(withNextPage([note(5), note(4)], [note(4), note(3)]))).toEqual(ids([note(5), note(4), note(3)]));
  });
});

describe('read marks', () => {
  it('marks one or all read, and puts one back as the server has it', () => {
    const at = '2026-10-23T08:00:00.000Z';
    const list = [note(3), note(2, true), note(1)];
    expect(withRead(list, note(3).id, at)[0]!.read_at).toBe(at);
    expect(withRead(list, note(2).id, at)[1]!.read_at).toBe(note(2, true).read_at);
    expect(withAllRead(list, at).every((item) => item.read_at)).toBe(true);
    expect(withItem(withRead(list, note(3).id, at), note(3))[0]!.read_at).toBeNull();
    expect(ids(withItem(list, note(4)))).toEqual(ids([note(4), note(3), note(2), note(1)]));
  });
});

describe('the offline copy', () => {
  it('round-trips, keeps the newest, and refuses what it cannot read', () => {
    const snapshot = toSnapshot({ items: [note(2), note(1)], nextCursor: 'c1', unread: 2, now: 5 });
    expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const many = Array.from({ length: SNAPSHOT_MAX + 5 }, (_, i) => note(SNAPSHOT_MAX + 5 - i));
    const cut = toSnapshot({ items: many, nextCursor: 'c9', unread: 0, now: 1 });
    expect(cut.items).toHaveLength(SNAPSHOT_MAX);
    expect(cut.nextCursor).toBeNull();
    expect(parseSnapshot({ v: 2, items: [] })).toBeNull();
    expect(parseSnapshot({ v: 1, items: [{ id: 1 }] })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });
});
