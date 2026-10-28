import { describe, expect, it } from 'vitest';
import { decodeRecentCursor, encodeRecentCursor } from '../recent-changes.js';

const raw = (at: string, key: string) => Buffer.from(JSON.stringify([at, key]), 'utf8').toString('base64url');

describe('the team activity cursor', () => {
  it('round-trips', () => {
    const cursor = { at: '2026-10-26T01:02:03.456789Z', key: 'kb:doc_1:u1' };
    expect(decodeRecentCursor(encodeRecentCursor(cursor))).toEqual(cursor);
  });

  it('refuses an impossible date or a hostile key instead of handing them to the database', () => {
    expect(decodeRecentCursor(raw('2026-13-26T00:00:00.000000Z', 'kb:x'))).toBeNull();
    expect(decodeRecentCursor(raw('2026-02-30T00:00:00.000000Z', 'kb:x'))).toBeNull();
    expect(decodeRecentCursor(raw('2026-10-26T00:00:00.000000Z', 'kb:\u0000x'))).toBeNull();
    expect(decodeRecentCursor(raw('2026-10-26T00:00:00.000000Z', 'k'.repeat(201)))).toBeNull();
  });

  it('refuses a plain timestamp', () => {
    expect(decodeRecentCursor('2026-10-26T00:00:00.000Z')).toBeNull();
  });
});
