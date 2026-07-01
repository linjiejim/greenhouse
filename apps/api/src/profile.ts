/**
 * Agent Profile — resolve and serve profile definitions.
 *
 * Two representations, ONE schema (`@greenhouse/types/profile-manifest`):
 * - System profiles: authored in TS via `defineProfile()` (profiles/*.ts),
 *   validated by `systemProfileSchema`. Registered statically below.
 * - Custom profiles: user rows in `custom_profiles` (a relational shell + a
 *   `data` jsonb manifest payload), resolved against their system base.
 *
 * The runtime contract consumed across the codebase is `AgentProfile`.
 */

import { logger } from '@greenhouse/utils/logger';
import { composeRichOutput } from '@greenhouse/utils/prompts';

// Model config types are owned by the agent kernel; re-exported here so the
// many profile consumers keep importing them from profile.js unchanged.
export type { ModelConfig, ModelOptions, ModelChoice } from '@greenhouse/agent-core';
import type { ModelConfig } from '@greenhouse/agent-core';

// Profile shape is owned by the shared manifest schema (single source of truth).
import { CUSTOM_BASE_PROFILE_IDS } from '@greenhouse/types/profile-manifest';
import type { AccessConfig, Capability } from '@greenhouse/types/profile-manifest';

import defaultProfile from './profiles/default.js';
import teamProfile from './profiles/team.js';
import { EXTENSION_SYSTEM_PROFILES } from './profiles/extensions.js';

// ─── Types ───────────────────────────────────────────────

export type { AccessConfig } from '@greenhouse/types/profile-manifest';
export type ProfileCapability = Capability;
export { CUSTOM_BASE_PROFILE_IDS };

/**
 * Resolved profile used at runtime. Structurally a superset-compatible view of
 * `SystemProfile`; custom profiles are resolved into this same shape. New
 * fields are OPTIONAL so the existing consumers stay unchanged.
 */
export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  hidden?: boolean; // true = system-only, not shown in UI profile picker
  access: AccessConfig; // declarative access control
  model: ModelConfig;
  tools: string[]; // tool names from the registry
  system_prompt: string;
  max_steps?: number; // default: 8
  tool_choice?: 'auto' | 'none' | 'required'; // default: "auto"
  capabilities?: ProfileCapability[]; // UI display capabilities
  version?: string; // last modified date (e.g. "2026-05-21")
  // ── Safe declarative config (custom profiles) ──
  default_language?: string;
  greeting?: string;
  suggested_followups?: string[];
}

// ─── Known Tools (for validation, driven by the registry) ─

let KNOWN_TOOLS = new Set<string>();

/**
 * Bulk-register tool names from the tool registry.
 * Called once at startup by `createToolRegistry()` in agent.ts.
 * Until then the set is empty and tool-name validation is skipped.
 */
export function registerKnownTools(names: string[]): void {
  KNOWN_TOOLS = new Set(names);
}

function assertKnownTools(profile: AgentProfile): void {
  if (KNOWN_TOOLS.size === 0) return; // registry not registered yet
  const unknown = profile.tools.filter((t) => !KNOWN_TOOLS.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `Profile "${profile.id}" references unknown tools: ${unknown.join(', ')}. ` +
        `Available tools: ${[...KNOWN_TOOLS].join(', ')}`,
    );
  }
}

// ─── System Profile Registry (TS modules) ─────────────────

// Core profiles + any private profiles a downstream fork contributes via
// profiles/extensions.ts (empty upstream). Splicing here means loadProfile /
// listProfileIds / resolveProfile all see fork profiles — the fork never edits
// this file.
const SYSTEM_PROFILES = new Map<string, AgentProfile>(
  [defaultProfile, teamProfile, ...EXTENSION_SYSTEM_PROFILES].map((p) => [p.id, p]),
);

const LEGACY_TEAM_PROFILE_IDS = new Set([
  'researcher',
  'writer',
  'project-assistant',
  'cs-quality',
  'ops-analyst',
  'cc-analyzer',
]);

/** Map removed/legacy interactive profile IDs to their canonical replacement. */
export function normalizeProfileId(profileId?: string | null): string | undefined {
  if (!profileId) return undefined;
  if (LEGACY_TEAM_PROFILE_IDS.has(profileId)) return 'team';
  return profileId;
}

export function isValidCustomBaseProfileId(profileId: string): boolean {
  return (CUSTOM_BASE_PROFILE_IDS as readonly string[]).includes(profileId);
}

/**
 * Validate that a profile ID is safe (no path traversal or special characters).
 */
function validateProfileId(id: string): void {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid profile ID: "${id}"`);
  }
}

/**
 * Load a single system profile by ID. Throws if it doesn't exist.
 */
export function loadProfile(id: string): AgentProfile {
  validateProfileId(id);
  const profile = SYSTEM_PROFILES.get(id);
  if (!profile) {
    throw new Error(`Profile not found: "${id}"`);
  }
  assertKnownTools(profile);
  return profile;
}

/** Load all system profiles. */
export function loadAllProfiles(): AgentProfile[] {
  return [...SYSTEM_PROFILES.values()];
}

/** List system profile IDs. */
export function listProfileIds(): string[] {
  return [...SYSTEM_PROFILES.keys()];
}

/** Get the default profile (always "default"). */
export function getDefaultProfile(): AgentProfile {
  return loadProfile('default');
}

/**
 * Resolve profile by ID, falling back to "default". Synchronous path handles
 * only system profiles; use resolveProfileAsync for `custom:*` IDs.
 */
export function resolveProfile(profileId?: string | null): AgentProfile {
  const normalized = normalizeProfileId(profileId);
  if (!normalized || normalized === 'default') {
    return getDefaultProfile();
  }
  return loadProfile(normalized);
}

/** Merge a custom profile's safe model knobs onto its base model config. */
function mergeCustomModel(
  base: ModelConfig,
  modelOptions?: { thinking?: boolean; temperature?: number; max_tokens?: number },
  choiceIds?: string[],
): ModelConfig {
  const options = modelOptions ? { ...base.options, ...modelOptions } : base.options;
  // Narrow switchable choices to the user-selected subset (⊆ base.choices).
  // No selection → inherit base choices. A base without choices stays pinned.
  const choices =
    choiceIds && choiceIds.length > 0 && base.choices
      ? base.choices.filter((c) => choiceIds.includes(c.id))
      : base.choices;
  return { ...base, options, choices };
}

/**
 * Resolve profile by ID, with async support for custom profiles from the DB.
 * Use this instead of resolveProfile() when custom:* IDs may be passed.
 */
export async function resolveProfileAsync(profileId?: string | null): Promise<AgentProfile> {
  const normalized = normalizeProfileId(profileId);
  if (!normalized || normalized === 'default') {
    return getDefaultProfile();
  }

  // Custom profile: load from database
  if (normalized.startsWith('custom:')) {
    const { getDb } = await import('@greenhouse/db');
    const customId = parseInt(normalized.slice(7), 10);
    if (isNaN(customId)) {
      throw new Error(`Invalid custom profile ID: "${normalized}"`);
    }
    const row = await getDb().customProfiles.getById(customId);
    if (!row) {
      // Custom profile was deleted — fall back to default gracefully
      logger.warn(`[Profile] ⚠️ Custom profile ${normalized} not found, falling back to default`);
      return getDefaultProfile();
    }

    // Load base profile for model + access ceiling (fall back if base invalid)
    let baseProfile: AgentProfile;
    try {
      const normalizedBase = normalizeProfileId(row.base_profile_id) ?? 'default';
      baseProfile = isValidCustomBaseProfileId(normalizedBase) ? loadProfile(normalizedBase) : loadProfile('team');
    } catch {
      baseProfile = getDefaultProfile();
    }

    const data = row.data;
    // default_language is enforced by appending a controlled directive (the
    // stored prompt stays clean for editing).
    let system_prompt = data.system_prompt;
    if (data.default_language) {
      system_prompt += `\n\n## Response Language\nAlways respond in ${data.default_language} unless the user explicitly requests another language.`;
    }

    return {
      id: normalized,
      name: row.name,
      description: data.description,
      hidden: false,
      access: {
        level: 'internal',
        requires_session: false,
        rich_output: baseProfile.access.rich_output,
      },
      model: mergeCustomModel(baseProfile.model, data.model_options, data.model_choice_ids),
      tools: data.tools,
      system_prompt,
      max_steps: data.max_steps,
      tool_choice: data.tool_choice ?? 'auto',
      capabilities: data.capabilities && data.capabilities.length > 0 ? data.capabilities : undefined,
      default_language: data.default_language,
      greeting: data.greeting,
      suggested_followups: data.suggested_followups,
    };
  }

  return loadProfile(normalized);
}

// ─── Cache hooks (kept for the /reload endpoint + consumers) ──
//
// System profiles are static TS modules now, so there is no file cache to
// clear; clearProfileCache still fires registered callbacks for consumers that
// rebuild derived state.

const onClearCallbacks: Array<() => void> = [];

/** Register a callback that runs when the profile cache is cleared. */
export function onProfileCacheClear(cb: () => void): void {
  onClearCallbacks.push(cb);
}

/** Fire cache-clear callbacks (no-op for the now-static profile registry). */
export function clearProfileCache(): void {
  for (const cb of onClearCallbacks) cb();
}

// ─── Access Control Helpers (derived from profiles) ──────

/** Get profile IDs with the given access level. */
export function getProfileIdsByLevel(level: AccessConfig['level']): Set<string> {
  return new Set(
    loadAllProfiles()
      .filter((p) => p.access.level === level)
      .map((p) => p.id),
  );
}

/** Profiles safe for public/anonymous access (level=public). */
export function getPublicProfileIds(): Set<string> {
  return getProfileIdsByLevel('public');
}

/** Profiles requiring session mode. */
export function getAdminProfileIds(): Set<string> {
  return new Set(
    loadAllProfiles()
      .filter((p) => p.access.requires_session)
      .map((p) => p.id),
  );
}

/** Profiles that receive rich output guide. */
export function getRichOutputProfileIds(): Set<string> {
  return new Set(
    loadAllProfiles()
      .filter((p) => p.access.rich_output)
      .map((p) => p.id),
  );
}

// ─── Rich Output Prompt Enrichment ───────────────────────

/**
 * Enrich a profile's system prompt with the rich output formatting guide.
 * Applies to any profile with `access.rich_output: true` — these also get the
 * confirm-button block. Default (rich_output: false) is unchanged.
 */
export function enrichSystemPrompt(profile: AgentProfile): string {
  if (!profile.access.rich_output) {
    return profile.system_prompt;
  }
  return profile.system_prompt + '\n' + composeRichOutput({ confirm: true });
}
