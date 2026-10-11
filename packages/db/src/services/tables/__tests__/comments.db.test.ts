/**
 * Tables record comments and the merged activity feed (slice C) against real
 * PostgreSQL, rolled back per test: comment storage rules, the newest-first
 * merge of comments and history with a stable `(created_at, source, id)`
 * cursor, field changes cut to what the reader may see, and row scopes on
 * every comment path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  _resetProvider,
  initDatabase,
  TablesValidationError,
  type DatabaseProvider,
  type TableRecordRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess, type TableAccessScope, type TableDataScope } from '@greenhouse/types/table-access';
import {
  TABLE_COMMENT_MAX_LENGTH,
  type TableRecordActivityItem,
  type TableRecordWriteMeta,
} from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { compareActivityPositions, decodeActivityCursor, encodeActivityCursor } from '../comments.js';

let db: DatabaseProvider;
let owner: UserRow;
let mate: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, mate] = await Promise.all([
    createInternalTestUser(db, { email: `tables-c-owner-${tag}@test.local`, nickname: 'Comment Owner' }),
    createInternalTestUser(db, { email: `tables-c-mate-${tag}@test.local`, nickname: 'Comment Mate' }),
  ]);
});

afterEach(() => {
  _resetProvider();
});

const full = (userId: string | null) => fullTableAccess(userId);
const meta = (actorId: string): TableRecordWriteMeta => ({ actorId, actorKind: 'user', enqueueAutomations: false });
const scoped = (tableId: number, userId: string, overrides: Partial<TableDataScope> = {}): TableDataScope => ({
  kind: 'scoped',
  userId,
  tableId,
  rows: [],
  editRows: [],
  readableFieldIds: [],
  editableFieldIds: [],
  canCreate: false,
  canDelete: false,
  ...overrides,
});

/**
 * History and comments are stamped in milliseconds; order-sensitive steps wait
 * a tick so each lands on its own instant (ties have their own test).
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function workspace() {
  const base = await db.tables.createBase({ name: 'Comments', owner_id: owner.id, created_by: owner.id });
  const schema = await db.tables.createTable({ base_id: base.id, name: 'Deals', created_by: owner.id });
  const tableId = schema.table.id;
  const primary = schema.fields[0]!;
  const stage = await db.tables.createField({ table_id: tableId, name: 'Stage', type: 'text', created_by: owner.id });
  const amount = await db.tables.createField({
    table_id: tableId,
    name: 'Amount',
    type: 'number',
    created_by: owner.id,
  });
  const record = await db.tables.createRecord(
    { table_id: tableId, values: { [primary.id]: 'Acme', [stage.id]: 'lead', [amount.id]: 100 } },
    full(owner.id),
    meta(owner.id),
  );
  let current: TableRecordRow = record;
  const update = async (values: Record<number, unknown>) => {
    await tick();
    const result = await db.tables.updateRecord(
      { table_id: tableId, record_id: current.id, revision: current.revision, values },
      full(owner.id),
      meta(owner.id),
    );
    if (!result.ok) throw new Error('update failed');
    current = result.record;
    return current;
  };
  const comment = async (body: string, authorId = owner.id) => {
    await tick();
    return db.tables.createComment({ tableId, recordId: record.id, authorId, body, mentions: [] }, full(authorId));
  };
  return { tableId, primary, stage, amount, record, update, comment };
}

const summary = (items: TableRecordActivityItem[]) =>
  items.map((item) => (item.kind === 'comment' ? `c:${item.body}` : `e:${item.type}`));

/** Read every page of a record's activity at `limit` per page. */
async function readAll(
  tableId: number,
  recordId: number,
  limit: number,
  scope: TableAccessScope = full(owner.id),
  readScope: TableAccessScope = scope,
): Promise<{ pages: TableRecordActivityItem[][]; all: TableRecordActivityItem[] }> {
  const pages: TableRecordActivityItem[][] = [];
  let cursor: string | null = null;
  do {
    const page = await db.tables.listRecordActivity(tableId, recordId, scope, readScope, { cursor, limit });
    if (!page) throw new Error('record not visible');
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor && pages.length < 50);
  return { pages, all: pages.flat() };
}

describe('Tables comments', () => {
  it('stores a trimmed Markdown body with de-duplicated mentions', async () => {
    const w = await workspace();
    const row = await db.tables.createComment(
      {
        tableId: w.tableId,
        recordId: w.record.id,
        authorId: owner.id,
        body: '  hi [@Mate](user:m)  ',
        mentions: [mate.id, mate.id, ''],
      },
      full(owner.id),
    );
    expect(row).toMatchObject({ body: 'hi [@Mate](user:m)', mentions: [mate.id], author_id: owner.id });
    expect(row!.created_at).toBe(row!.updated_at);
  });

  it('refuses empty and oversized bodies', async () => {
    const w = await workspace();
    await expect(w.comment('   ')).rejects.toBeInstanceOf(TablesValidationError);
    await expect(w.comment('x'.repeat(TABLE_COMMENT_MAX_LENGTH + 1))).rejects.toThrow(/limited/);
    await expect(w.comment('x'.repeat(TABLE_COMMENT_MAX_LENGTH))).resolves.toBeDefined();
  });

  it('edits and soft-deletes; a deleted comment is gone from every path', async () => {
    const w = await workspace();
    const created = (await w.comment('first'))!;
    const edited = await db.tables.updateComment(created.id, { body: 'second', mentions: [] }, full(owner.id));
    expect(edited).toMatchObject({ body: 'second' });
    const [view] = (await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id)))!.items;
    expect(view).toMatchObject({ kind: 'comment', body: 'second', edited: true });

    expect(await db.tables.deleteComment(created.id, full(owner.id))).toMatchObject({ id: created.id });
    expect(await db.tables.getComment(created.id)).toBeUndefined();
    expect(await db.tables.deleteComment(created.id, full(owner.id))).toBeUndefined();
    expect(await db.tables.updateComment(created.id, { body: 'x', mentions: [] }, full(owner.id))).toBeUndefined();
    const page = await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id));
    expect(summary(page!.items)).toEqual(['e:created']);
  });

  it('keeps comments on records outside the row scope unreachable', async () => {
    const w = await workspace();
    const existing = (await w.comment('owner note'))!;
    // `mate` may only read rows they created; the owner created this one.
    const mine = scoped(w.tableId, mate.id, {
      rows: [{ type: 'related', creator: true, fieldIds: [] }],
      readableFieldIds: [w.primary.id],
    });
    expect(
      await db.tables.createComment(
        { tableId: w.tableId, recordId: w.record.id, authorId: mate.id, body: 'hi', mentions: [] },
        mine,
      ),
    ).toBeUndefined();
    expect(await db.tables.updateComment(existing.id, { body: 'x', mentions: [] }, mine)).toBeUndefined();
    expect(await db.tables.deleteComment(existing.id, mine)).toBeUndefined();
    expect(await db.tables.listRecordActivity(w.tableId, w.record.id, mine, mine)).toBeUndefined();
    // A scope for one table never reads another table's record.
    await expect(db.tables.listRecordActivity(w.tableId + 100_000, w.record.id, mine, mine)).rejects.toThrow(/scope/);
  });
});

describe('Tables record activity', () => {
  it('merges comments and history newest first and pages without gaps or repeats', async () => {
    const w = await workspace();
    await w.comment('one');
    await w.update({ [w.stage.id]: 'qualified' });
    await w.comment('two');
    await w.update({ [w.amount.id]: 250 });
    await w.comment('three');

    const everything = await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id), {
      limit: 50,
    });
    expect(summary(everything!.items)).toEqual(['c:three', 'e:updated', 'c:two', 'e:updated', 'c:one', 'e:created']);
    expect(everything!.nextCursor).toBeNull();

    for (const limit of [1, 2, 4]) {
      const { pages, all } = await readAll(w.tableId, w.record.id, limit);
      expect(summary(all)).toEqual(summary(everything!.items));
      expect(pages.every((page) => page.length <= limit)).toBe(true);
    }
  });

  it('keeps a cursor stable while new activity arrives on top', async () => {
    const w = await workspace();
    await w.comment('a');
    await w.comment('b');
    await w.comment('c');
    const first = (await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id), {
      limit: 2,
    }))!;
    expect(summary(first.items)).toEqual(['c:c', 'c:b']);

    await w.comment('newer');
    await w.update({ [w.stage.id]: 'won' });
    const second = (await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id), {
      cursor: first.nextCursor,
      limit: 2,
    }))!;
    expect(summary(second.items)).toEqual(['c:a', 'e:created']);
    expect(second.nextCursor).toBeNull();
  });

  it('breaks timestamp ties by source then id, across page boundaries', async () => {
    const w = await workspace();
    const c1 = (await w.comment('tie-1'))!;
    const c2 = (await w.comment('tie-2'))!;
    await w.update({ [w.stage.id]: 'tied' });
    const at = '2026-01-01T00:00:00.000000Z';
    await db.executeRaw(
      sql`UPDATE table_record_comments SET created_at = ${at}::timestamptz, updated_at = ${at}::timestamptz WHERE record_id = ${w.record.id}`,
    );
    await db.executeRaw(
      sql`UPDATE table_record_events SET created_at = ${at}::timestamptz WHERE record_id = ${w.record.id}`,
    );

    // Same instant: events sort before comments, each source by id descending.
    const expected = ['e:updated', 'e:created', 'c:tie-2', 'c:tie-1'];
    const once = await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id));
    expect(summary(once!.items)).toEqual(expected);
    const { all } = await readAll(w.tableId, w.record.id, 1);
    expect(summary(all)).toEqual(expected);
    expect(all.filter((item) => item.kind === 'comment').map((item) => item.id)).toEqual([c2.id, c1.id]);
  });

  it('cuts field changes to what the reader may see and drops updates that leave nothing', async () => {
    const w = await workspace();
    await w.update({ [w.amount.id]: 999 }); // hidden only → dropped for the scoped reader
    await w.update({ [w.stage.id]: 'won', [w.amount.id]: 1000 }); // mixed → only Stage survives
    await w.comment('visible note');

    const reader = scoped(w.tableId, mate.id, { readableFieldIds: [w.primary.id, w.stage.id] });
    const { all } = await readAll(w.tableId, w.record.id, 1, reader);
    expect(summary(all)).toEqual(['c:visible note', 'e:updated', 'e:created']);
    const fieldIdsOf = (item: TableRecordActivityItem) =>
      item.kind === 'event' ? item.changes.map((change) => change.fieldId).sort((a, b) => a - b) : [];
    expect(fieldIdsOf(all[1]!)).toEqual([w.stage.id]);
    expect(fieldIdsOf(all[2]!)).toEqual([w.primary.id, w.stage.id].sort((a, b) => a - b));
    expect(JSON.stringify(all)).not.toContain('999');
    expect(JSON.stringify(all)).not.toContain('1000');

    // The owner sees every change, including the hidden-only update.
    const ownerView = await readAll(w.tableId, w.record.id, 50);
    expect(summary(ownerView.all)).toEqual(['c:visible note', 'e:updated', 'e:updated', 'e:created']);
  });

  it('shows a masked reader who and when, never a value', async () => {
    const w = await workspace();
    await w.update({ [w.stage.id]: 'won' });
    const valueless = scoped(w.tableId, mate.id);
    const page = await db.tables.listRecordActivity(w.tableId, w.record.id, full(mate.id), valueless);
    expect(summary(page!.items)).toEqual(['e:created']);
    expect(page!.items[0]).toMatchObject({ kind: 'event', type: 'created', changes: [], actorId: owner.id });
  });

  it('leaves archived fields out of history for everyone', async () => {
    const w = await workspace();
    await w.update({ [w.amount.id]: 5 });
    await db.tables.archiveField(w.amount.id, owner.id);
    const page = await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id));
    expect(summary(page!.items)).toEqual(['e:created']);
  });

  it('omits comments when asked and keeps deleted / restored events', async () => {
    const w = await workspace();
    await w.comment('hidden from this reader');
    const deleted = await db.tables.deleteRecord(
      { table_id: w.tableId, record_id: w.record.id, revision: w.record.revision },
      full(owner.id),
      meta(owner.id),
    );
    expect(deleted.ok).toBe(true);
    await db.tables.restoreRecord({ table_id: w.tableId, record_id: w.record.id }, full(owner.id), meta(owner.id));
    const page = await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id), {
      includeComments: false,
    });
    expect(summary(page!.items)).toEqual(['e:restored', 'e:deleted', 'e:created']);
  });

  it('rejects a forged cursor and clamps the page size', async () => {
    const w = await workspace();
    await expect(
      db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id), { cursor: 'nope' }),
    ).rejects.toBeInstanceOf(TablesValidationError);
    const forged = Buffer.from(JSON.stringify(['2026-01-01', 'event', 1])).toString('base64url');
    await expect(
      db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id), { cursor: forged }),
    ).rejects.toThrow(/cursor/);
    for (let index = 0; index < 55; index += 1) {
      await db.tables.createComment(
        { tableId: w.tableId, recordId: w.record.id, authorId: owner.id, body: `n${index}`, mentions: [] },
        full(owner.id),
      );
    }
    const page = await db.tables.listRecordActivity(w.tableId, w.record.id, full(owner.id), full(owner.id), {
      limit: 500,
    });
    expect(page!.items).toHaveLength(50);
    expect(page!.nextCursor).not.toBeNull();
  });
});

describe('activity cursor helpers', () => {
  it('round-trips and orders newest first', () => {
    const position = { at: '2026-10-11T03:04:05.123456Z', source: 'event' as const, id: 7 };
    expect(decodeActivityCursor(encodeActivityCursor(position))).toEqual(position);
    const older = { ...position, at: '2026-10-11T03:04:05.123455Z' };
    const comment = { ...position, source: 'comment' as const, id: 99 };
    expect([older, comment, position].sort(compareActivityPositions)).toEqual([position, comment, older]);
  });
});
