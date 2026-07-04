/**
 * Integration test — the Drizzle CRUD adapter (createTableCrudService) against a
 * real Postgres, driven through the provider's `crudDemo` service (crud_demo_items).
 * Mirrors the tests/api DB setup: greenhouse_test + resetSchema in beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

let db: DatabaseProvider;

beforeAll(async () => {
  db = await initDatabase({
    type: 'pg',
    pgConnectionString: 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test',
  });
});

beforeEach(async () => {
  await db.resetSchema();
});

describe('createTableCrudService (via db.crudDemo)', () => {
  it('creates with auto timestamps + JSON tags round-trip', async () => {
    const row = (await db.crudDemo.create({
      name: 'Basil',
      category: 'plant',
      status: 'active',
      priority: 3,
      is_featured: true,
      tags: ['herb', 'indoor'],
      notes: 'grows fast',
    })) as any;
    expect(row.id).toBeGreaterThan(0);
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    // tags stored as JSON text, parsed back to an array on the way out.
    expect(row.tags).toEqual(['herb', 'indoor']);
  });

  it('lists with like/eq filters, sort, pagination + total', async () => {
    for (const n of ['apple', 'apricot', 'banana']) {
      await db.crudDemo.create({ name: n, category: 'plant', status: n === 'banana' ? 'archived' : 'active' });
    }
    // like filter
    const ap = await db.crudDemo.list({
      filter: [{ key: 'name', method: 'like', value: ['ap'] }],
      sort: [{ key: 'name', order: 'asc' }],
    });
    expect(ap.total).toBe(2);
    expect(ap.items.map((r: any) => r.name)).toEqual(['apple', 'apricot']);

    // eq filter
    const active = await db.crudDemo.list({ filter: [{ key: 'status', method: 'eq', value: ['active'] }] });
    expect(active.total).toBe(2);

    // pagination: total reflects the full match, items the page.
    const page = await db.crudDemo.list({ limit: 1, skip: 0, sort: [{ key: 'name', order: 'asc' }] });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect((page.items[0] as any).name).toBe('apple');
  });

  it('gets, updates (bumps updated_at), and deletes', async () => {
    const created = (await db.crudDemo.create({ name: 'x', priority: 1 })) as any;
    const id = String(created.id);

    const got = (await db.crudDemo.get(id)) as any;
    expect(got.name).toBe('x');

    const updated = (await db.crudDemo.update(id, { priority: 9, notes: 'edited' })) as any;
    expect(updated.priority).toBe(9);
    expect(updated.notes).toBe('edited');
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(created.updated_at).getTime());

    expect(await db.crudDemo.remove(id)).toBe(true);
    expect(await db.crudDemo.get(id)).toBeNull();
    expect(await db.crudDemo.remove(id)).toBe(false);
  });

  it('ignores non-writable / unknown keys on write', async () => {
    const created = (await db.crudDemo.create({ name: 'safe', id: 999999, bogus: 'x' } as any)) as any;
    // id is managed internally (serial), not taken from the payload.
    expect(created.id).not.toBe(999999);
    expect('bogus' in created).toBe(false);
  });
});
