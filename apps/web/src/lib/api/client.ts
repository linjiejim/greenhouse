/**
 * Typed RPC client over the whole API surface (@greenhouse/contract AppType).
 *
 * Auth (Bearer header + 401 refresh-retry + desktop URL resolution) rides on
 * authFetch as the custom fetch. Response types flow from the server's actual
 * `c.json(...)` returns — a server shape change becomes a compile error in
 * the functions below, not a silent runtime drift.
 *
 * Conventions for the lib/api/* modules built on this client:
 * - Exported function signatures (params + declared return types) stay stable;
 *   TS structurally checks the inferred response against the declared type.
 * - `safe*` semantics (fallback on any error) are inlined per function:
 *   try → `if (!res.ok) return fallback` → `field ?? fallback` → catch → fallback.
 * - Streaming endpoints (chat NDJSON, sync apply) and FormData uploads stay on
 *   raw authFetch — hc is for JSON request/response.
 * - No `as` casts on responses. If inferred and declared types conflict, that
 *   is real drift — fix the truth, don't cast over it.
 */

import { hc, type AppType } from '@greenhouse/contract';
import { authFetch } from '../auth';

export const rpc = hc<AppType>('', { fetch: authFetch });
