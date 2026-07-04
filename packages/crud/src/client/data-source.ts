/**
 * CrudDataSource — the client's view of a resource. Same five operations as the
 * server CrudService, but it runs in the browser, so it can be:
 *
 *  1. createRestDataSource(base, authFetch) — talk to a createCrudRoutes endpoint
 *     (the one-stop path, and the fork-proxy path since the protocol matches).
 *  2. A hand-written adapter over existing hc/typed routes (migrate a page with
 *     zero server change).
 *
 * Mutations are optional so a read-only resource can omit them.
 */

import type { ListParams, ListResult } from '../protocol/types.js';

export interface CrudDataSource<TRow> {
  list(params: ListParams): Promise<ListResult<TRow>>;
  get(id: string): Promise<TRow>;
  create?(data: Record<string, unknown>): Promise<unknown>;
  update?(id: string, data: Record<string, unknown>): Promise<unknown>;
  remove?(id: string): Promise<unknown>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function unwrap(res: Response): Promise<any> {
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  // 204/empty bodies → null
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * A data source backed by a standard createCrudRoutes endpoint mounted at `base`
 * (e.g. '/api/crud/demo'). `fetcher` is the app's authenticated fetch (authFetch)
 * — injected because web/mobile/browser each have their own.
 */
export function createRestDataSource<TRow>(base: string, fetcher: Fetcher): Required<CrudDataSource<TRow>> {
  const b = base.replace(/\/+$/, '');
  const jsonHeaders = { 'Content-Type': 'application/json' };
  return {
    async list(params: ListParams): Promise<ListResult<TRow>> {
      const res = await fetcher(`${b}/list`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(params ?? {}),
      });
      return unwrap(res);
    },
    async get(id: string): Promise<TRow> {
      return unwrap(await fetcher(`${b}/${encodeURIComponent(id)}`));
    },
    async create(data: Record<string, unknown>): Promise<unknown> {
      return unwrap(await fetcher(b, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(data) }));
    },
    async update(id: string, data: Record<string, unknown>): Promise<unknown> {
      return unwrap(
        await fetcher(`${b}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: jsonHeaders,
          body: JSON.stringify(data),
        }),
      );
    },
    async remove(id: string): Promise<unknown> {
      return unwrap(await fetcher(`${b}/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    },
  };
}
