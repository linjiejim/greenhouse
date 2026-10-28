/**
 * Friction field limits — a LEAF module with ZERO imports.
 *
 * Same reason as llm/memory-limits.ts: the `log_friction` tool interpolates
 * these into its description at module-evaluation time, and tool modules are all
 * pulled in by tools/registry.ts. Constants read during module eval must not sit
 * behind an import chain that can close a cycle.
 */

export const FRICTION_SUMMARY_MAX = 120;
export const FRICTION_DETAIL_MAX = 1000;
