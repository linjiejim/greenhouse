/**
 * The one built-in agent — mirrors `apps/api/src/profiles/sprouty.yaml`.
 *
 * quick / deep / K3 / workflows collapsed into it on 2026-08-01: they differed
 * only by model (and, for workflows, a planner prompt — Workflows themselves were
 * retired in v1.4). The model is a per-turn choice next to the composer, not an
 * agent's identity.
 */

export const DEFAULT_AGENT_ID = 'sprouty';

/** Declared order — the picker and the Agents page both render presets this way. */
export const PRESET_AGENT_IDS = [DEFAULT_AGENT_ID] as const;

/** Retired profile ids still stored on sessions/scheduled tasks. */
export const LEGACY_AGENT_IDS = new Set([
  'sprouty-quick',
  'sprouty-deep',
  'sprouty-k3',
  'sprouty-workflows',
  'sprouty-mission',
  'workflow-planner',
  'sprouty-agents',
  'team',
  'eval-judge',
  'default',
  'desktop',
  'local-pi',
  'local-dev',
  'researcher',
  'writer',
  'project-assistant',
]);
