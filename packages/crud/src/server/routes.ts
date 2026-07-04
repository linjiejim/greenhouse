/**
 * createCrudRoutes — a Hono sub-app that exposes a CrudService over the standard
 * CRUD protocol:
 *
 *   POST   /list      → ListParams  → { items, total }
 *   GET    /:id       → row | 404
 *   POST   /          → create      → row (201)
 *   PUT    /:id       → update      → row | 404
 *   DELETE /:id       → { ok: true } | 404
 *
 * Guards (read/write/delete) are per-method middleware — reuse the app's own
 * requireInternal()/requireSuper()/requireFeature(). Hooks are the server-side
 * escape hatch: scopeFilter (row-level isolation), before/after mutation hooks,
 * and canAccess (per-row guard for get/update/delete).
 *
 * The env is intentionally `any`: the factory is generic over the host app's
 * Hono environment, and mounting it must not widen a typed AppType — so mount
 * these routes OUTSIDE the contract chain (like /api/client-tools).
 */

import { Hono, type Context, type Handler, type MiddlewareHandler } from 'hono';

import type { FilterItem } from '../protocol/types.js';
import type { CrudService } from './service.js';
import { validateListParams, type ListContract } from './validate.js';

export interface CrudHooks<TRow> {
  /** Extra filters AND-ed into every list — e.g. force user_id = current user. */
  scopeFilter?: (c: Context) => FilterItem[] | Promise<FilterItem[]>;
  /** Per-row guard for get/update/delete. Return false → treated as 404. */
  canAccess?: (row: TRow, c: Context) => boolean | Promise<boolean>;
  beforeCreate?: (
    data: Record<string, unknown>,
    c: Context,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  afterCreate?: (row: TRow, c: Context) => void | Promise<void>;
  beforeUpdate?: (
    id: string,
    data: Record<string, unknown>,
    c: Context,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  afterUpdate?: (row: TRow, c: Context) => void | Promise<void>;
  beforeDelete?: (id: string, c: Context) => void | Promise<void>;
}

export interface CrudRouteOptions<TRow> extends ListContract {
  guards?: {
    read?: MiddlewareHandler[];
    write?: MiddlewareHandler[];
    /** Defaults to `write` guards when omitted. */
    delete?: MiddlewareHandler[];
  };
  hooks?: CrudHooks<TRow>;
  /** Validate/whitelist the create body. Return the sanitized object, or throw to 400. */
  parseCreate?: (raw: unknown) => Record<string, unknown>;
  /** Validate/whitelist the update body. Return the sanitized object, or throw to 400. */
  parseUpdate?: (raw: unknown) => Record<string, unknown>;
}

export function createCrudRoutes<TRow>(service: CrudService<TRow>, opts: CrudRouteOptions<TRow> = {}): Hono<any> {
  const app = new Hono<any>();
  const read = opts.guards?.read ?? [];
  const write = opts.guards?.write ?? [];
  const del = opts.guards?.delete ?? write;
  const hooks = opts.hooks ?? {};

  const listHandler: Handler = async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const result = validateListParams(raw, opts);
    if (!result.ok) return c.json({ error: result.error }, 400);

    const scoped = hooks.scopeFilter ? await hooks.scopeFilter(c) : [];
    const filter: FilterItem[] = [...(result.params.filter ?? []), ...scoped];
    const data = await service.list({ ...result.params, filter });
    return c.json(data);
  };

  const getHandler: Handler = async (c) => {
    const id = c.req.param('id') ?? '';
    const row = await service.get(id);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (hooks.canAccess && !(await hooks.canAccess(row, c))) return c.json({ error: 'Not found' }, 404);
    return c.json(row as Record<string, unknown>);
  };

  const createHandler: Handler = async (c) => {
    let body: Record<string, unknown>;
    try {
      const raw = await c.req.json().catch(() => ({}));
      body = opts.parseCreate ? opts.parseCreate(raw) : (raw as Record<string, unknown>);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid body' }, 400);
    }
    if (hooks.beforeCreate) body = await hooks.beforeCreate(body, c);
    const row = await service.create(body);
    if (hooks.afterCreate) await hooks.afterCreate(row, c);
    return c.json(row as Record<string, unknown>, 201);
  };

  const updateHandler: Handler = async (c) => {
    const id = c.req.param('id') ?? '';
    if (hooks.canAccess) {
      const existing = await service.get(id);
      if (!existing) return c.json({ error: 'Not found' }, 404);
      if (!(await hooks.canAccess(existing, c))) return c.json({ error: 'Not found' }, 404);
    }
    let body: Record<string, unknown>;
    try {
      const raw = await c.req.json().catch(() => ({}));
      body = opts.parseUpdate ? opts.parseUpdate(raw) : (raw as Record<string, unknown>);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid body' }, 400);
    }
    if (hooks.beforeUpdate) body = await hooks.beforeUpdate(id, body, c);
    const row = await service.update(id, body);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (hooks.afterUpdate) await hooks.afterUpdate(row, c);
    return c.json(row as Record<string, unknown>);
  };

  const deleteHandler: Handler = async (c) => {
    const id = c.req.param('id') ?? '';
    if (hooks.canAccess) {
      const existing = await service.get(id);
      if (!existing) return c.json({ error: 'Not found' }, 404);
      if (!(await hooks.canAccess(existing, c))) return c.json({ error: 'Not found' }, 404);
    }
    if (hooks.beforeDelete) await hooks.beforeDelete(id, c);
    const ok = await service.remove(id);
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  };

  // Register with per-method guards. Cast through `any`: spreading a runtime
  // middleware array into Hono's variadic route method defeats its overload
  // inference (it treats the path string as a handler), but the runtime chain
  // is exactly [path, ...guards, handler].
  const on = (
    method: 'post' | 'get' | 'put' | 'delete',
    path: string,
    guards: MiddlewareHandler[],
    handler: Handler,
  ) => {
    (app as any)[method](path, ...guards, handler);
  };

  on('post', '/list', read, listHandler);
  on('get', '/:id', read, getHandler);
  on('post', '/', write, createHandler);
  on('put', '/:id', write, updateHandler);
  on('delete', '/:id', del, deleteHandler);

  return app;
}
