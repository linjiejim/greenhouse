/** Unit tests — createCrudRoutes over an in-memory service (no DB). */

import { describe, it, expect, beforeEach } from 'vitest';
import { createCrudRoutes } from '../server/routes.js';
import type { CrudService } from '../server/service.js';
import type { ListParams, ListResult } from '../protocol/types.js';

interface Item {
  id: number;
  name: string;
  status: string;
}

function memoryService(seed: Item[]): CrudService<Item> {
  let rows = [...seed];
  let nextId = Math.max(0, ...seed.map((r) => r.id)) + 1;
  return {
    async list(params: ListParams): Promise<ListResult<Item>> {
      let out = rows;
      for (const f of params.filter ?? []) {
        if (f.key === 'status' && f.method === 'eq') out = out.filter((r) => r.status === f.value[0]);
        if (f.key === 'name' && f.method === 'like') out = out.filter((r) => r.name.includes(String(f.value[0])));
      }
      const total = out.length;
      const skip = params.skip ?? 0;
      const limit = params.limit ?? 20;
      return { items: out.slice(skip, skip + limit), total };
    },
    async get(id) {
      return rows.find((r) => String(r.id) === id) ?? null;
    },
    async create(data) {
      const row = { id: nextId++, name: String(data.name ?? ''), status: String(data.status ?? 'new') };
      rows.push(row);
      return row;
    },
    async update(id, data) {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) return null;
      Object.assign(row, data);
      return row;
    },
    async remove(id) {
      const before = rows.length;
      rows = rows.filter((r) => String(r.id) !== id);
      return rows.length < before;
    },
  };
}

const opts = {
  filterable: {
    status: { type: 'text' as const, methods: ['eq' as const] },
    name: { type: 'text' as const, methods: ['like' as const] },
  },
  sortable: ['name'],
};

let app: ReturnType<typeof createCrudRoutes<Item>>;

beforeEach(() => {
  app = createCrudRoutes(
    memoryService([
      { id: 1, name: 'alpha', status: 'active' },
      { id: 2, name: 'beta', status: 'archived' },
    ]),
    opts,
  );
});

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createCrudRoutes', () => {
  it('POST /list returns items + total', async () => {
    const res = await post('/list', {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.items).toHaveLength(2);
  });

  it('POST /list applies a valid filter', async () => {
    const res = await post('/list', { filter: [{ key: 'status', method: 'eq', value: ['active'] }] });
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.items[0].name).toBe('alpha');
  });

  it('POST /list rejects an unknown filter key with 400', async () => {
    const res = await post('/list', { filter: [{ key: 'evil', method: 'eq', value: ['x'] }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not filterable/);
  });

  it('GET /:id returns a row or 404', async () => {
    expect((await app.request('/1')).status).toBe(200);
    expect((await app.request('/999')).status).toBe(404);
  });

  it('POST / creates (201) and DELETE removes', async () => {
    const created = await post('/', { name: 'gamma', status: 'active' });
    expect(created.status).toBe(201);
    const row = await created.json();
    expect(row.name).toBe('gamma');
    const del = await app.request(`/${row.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await app.request(`/${row.id}`)).status).toBe(404);
  });

  it('PUT /:id updates and 404s for a missing row', async () => {
    const res = await app.request('/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('archived');
    const miss = await app.request('/999', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'x' }),
    });
    expect(miss.status).toBe(404);
  });

  it('read guard middleware runs before the handler', async () => {
    const guarded = createCrudRoutes(memoryService([]), {
      ...opts,
      guards: { read: [async (c) => c.json({ error: 'blocked' }, 403)] },
    });
    const res = await guarded.request('/list', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });

  it('scopeFilter is AND-ed into the query', async () => {
    const scoped = createCrudRoutes(
      memoryService([
        { id: 1, name: 'alpha', status: 'active' },
        { id: 2, name: 'beta', status: 'archived' },
      ]),
      {
        ...opts,
        hooks: { scopeFilter: () => [{ key: 'status', method: 'eq', value: ['archived'] }] },
      },
    );
    const res = await scoped.request('/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.items[0].name).toBe('beta');
  });
});
