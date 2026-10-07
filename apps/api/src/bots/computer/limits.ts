/**
 * Ranges of the two live computer knobs (workspace settings), and the
 * human-wait hold shared by the lifecycle and the cards. A dependency-free
 * module: settings/workspace-config.ts validates writes with it, and
 * config.ts (which reads the settings) parses with it.
 */

export const IDLE_MINUTES_RANGE = { min: 5, max: 240, fallback: 15 } as const;
export const MAX_RUNNING_RANGE = { min: 1, max: 50, fallback: 2 } as const;

/**
 * How long a pending secure sign-in or take-over card protects the member's
 * computer from idle shutdown and LRU eviction (the page it waits on must
 * survive until the member answers). The same value should be the card's
 * expiry, so protection and the card end together; bounded so one forgotten
 * card cannot hold one of the organisation's few slots forever.
 */
export const HUMAN_WAIT_HOLD_MS = 60 * 60_000;
