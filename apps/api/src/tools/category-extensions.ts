/**
 * Fork extension point for tool AUDIENCE categories — the ONLY file a downstream
 * fork edits to add private `ToolCategory` values (see define.ts's ToolCategory).
 *
 * Upstream (greenhouse) ships this as `never` (no extra categories). A downstream
 * fork widens the union WITHOUT touching define.ts — so define.ts stays
 * byte-identical to upstream and never conflicts when the fork syncs upstream:
 *
 *   export type ExtensionToolCategory = 'admin' | 'local';
 *
 * This file imports NOTHING, so define.ts can import it without an import cycle
 * (define.ts is itself import-free from tool files by design — see its header).
 * Parallels EXTENSION_TOOL_MODULES in extensions.ts: the seam for adding tools;
 * this is the seam for adding the audience categories those tools may use.
 */

/** Extra ToolCategory audience values contributed by a downstream fork. Empty (never) upstream. */
export type ExtensionToolCategory = never;
