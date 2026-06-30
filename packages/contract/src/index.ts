/**
 * @greenhouse/contract — the typed API contract shared by all clients.
 *
 * `AppType` is the full Hono route schema inferred from the server's actual
 * implementation (apps/api mountRoutes) — responses derive from `c.json(...)`
 * return values, which in turn derive from @greenhouse/db `$inferSelect` rows.
 * There is no handwritten endpoint mirror anywhere in this chain.
 *
 * Usage (any client):
 *   import { hc, type AppType } from '@greenhouse/contract';
 *   const client = hc<AppType>(BASE_URL, { fetch: myAuthFetch });
 *   const res = await client.api.profiles.$get();
 *   if (res.ok) { const { profiles } = await res.json(); }
 *
 * ⚠️ Import ONLY types from @greenhouse/api here (`export type`/`import type`).
 * A value import would execute the server entry point (it calls main()).
 *
 * Streaming endpoints (chat NDJSON) return raw streams — clients keep their
 * hand-rolled readers for those; hc still types the paths and request shapes.
 */

export type { AppType } from '@greenhouse/api';
export { hc } from 'hono/client';
export type { InferRequestType, InferResponseType } from 'hono/client';
