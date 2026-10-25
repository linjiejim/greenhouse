import { describe, expect, it } from 'vitest';
import { sharedRows } from './shares';

const share = (id: string, session: string, created: string, read: string | null = null) => ({
  id,
  session_id: session,
  read_at: read,
  created_at: created,
});

describe('sharedRows', () => {
  it('folds shares of one conversation into one row, newest first', () => {
    const rows = sharedRows([
      share('1', 'a', '2026-10-20 09:00:00+00', '2026-10-20 10:00:00+00'),
      share('2', 'b', '2026-10-22 09:00:00+00', '2026-10-22 10:00:00+00'),
      share('3', 'a', '2026-10-24 09:00:00+00'),
    ]);
    expect(rows.map((row) => row.share.id)).toEqual(['3', '2']);
    expect(rows[0]).toMatchObject({ ids: ['1', '3'], unread: true });
    expect(rows[1]).toMatchObject({ ids: ['2'], unread: false });
  });

  it('is empty without shares', () => {
    expect(sharedRows([])).toEqual([]);
  });
});
