/**
 * Fork extension point for the tool catalog — the ONLY file a downstream fork
 * edits to add private agent tools.
 *
 * Upstream (greenhouse) ships this EMPTY. A downstream fork adds its private tool
 * modules here (import the module, push it into the array) WITHOUT touching
 * `registry.ts` — so `registry.ts` stays byte-identical to upstream and never
 * conflicts when the fork syncs upstream.
 *
 * `registry.ts` splices `EXTENSION_TOOL_MODULES` into its module list BEFORE it
 * derives every aggregate view (metadata, global/public id sets, the proxy/MCP
 * allowlists, the static/lazy factories). So a private tool that sets
 * `meta.surface` is auto-exposed over `/api/agent` + `/api/mcp` under the SAME
 * default-deny rules as a core tool — no allowlist edits, no extra wiring.
 *
 * Fork example (in the fork's copy of this file):
 *
 *   import { crmQueryTool } from './crm/crm-query.js';
 *   import { crmMutationTool } from './crm/crm-mutation.js';
 *   export const EXTENSION_TOOL_MODULES: ToolModule[] = [crmQueryTool, crmMutationTool];
 *
 * The registry-catalog behavior-lock test derives its extension entries from this
 * array, so a fork adding a `kind: 'lazy'` tool does NOT edit that test on sync.
 */

import type { ToolModule } from './define.js';

/** Private tool modules contributed by a downstream fork. Empty upstream. */
export const EXTENSION_TOOL_MODULES: ToolModule[] = [];
