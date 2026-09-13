/**
 * Workflow run constants shared by the dock and the plan card.
 */

/**
 * Run statuses that mean "not finished" — the dock keeps its safety-net refresh
 * alive while one holds. `paused` is included: the user can resume at any time.
 */
export const ACTIVE_RUN_STATUSES = new Set(['running', 'paused', 'paused_for_gate']);
