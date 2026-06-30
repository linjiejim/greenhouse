/**
 * Agent Profile — load, validate, and resolve YAML profile definitions.
 *
 * Profiles define: identity, model config, tool subset, system prompt, and behavior.
 * Located in src/api/profiles/*.yaml
 *
 * Features:
 * - YAML-based profile definitions
 * - Tool name validation against known registry
 * - In-memory cache with file watcher for dev hot-reload
 */

import { readFileSync, readdirSync, existsSync, watch } from 'node:fs';
import { logger } from '@greenhouse/utils/logger';
import { composeRichOutput } from '@greenhouse/utils/prompts';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ─── Types ───────────────────────────────────────────────

// Model config types are owned by the agent kernel; re-exported here so the
// many profile consumers keep importing them from profile.js unchanged.
export type { ModelConfig, ModelOptions, ModelChoice } from '@greenhouse/agent-core';
import type { ModelConfig, ModelOptions, ModelChoice } from '@greenhouse/agent-core';
import { getModelEntry } from '@greenhouse/agent-core';

export interface ProfileCapability {
  icon: string; // Lucide icon name (e.g. "Search", "Globe")
  label: string; // Short label for display
  prompt: string; // Prompt to fill into input when clicked
}

export interface AccessConfig {
  level: 'public' | 'internal' | 'admin' | 'hidden'; // access tier
  requires_session: boolean; // must use session mode (not stateless)
  rich_output: boolean; // inject rich output formatting guide
}

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
}

// ─── Known Tools (for validation) ────────────────────────

const KNOWN_TOOLS = new Set([
  'analyze_image',
  'external_search',
  'feature_request',
  'generate_image',
  'project_manager',
  'ask_user',
  'knowledge_query',
  'knowledge_mutation',
  'team_knowledge',
  'personal_knowledge',
  'email_manager',
  'session_history',
  'compute',
]);

/**
 * Bulk-register tool names from the tool registry.
 * Called once at startup by `createToolRegistry()` in agent.ts.
 * After this call, KNOWN_TOOLS is driven entirely by the registry.
 */
export function registerKnownTools(names: string[]): void {
  KNOWN_TOOLS.clear();
  for (const name of names) KNOWN_TOOLS.add(name);
}

// ─── Profile Directory ───────────────────────────────────

const PROFILES_DIR = resolve(import.meta.dirname, 'profiles');

// ─── Loader ──────────────────────────────────────────────

const profileCache = new Map<string, AgentProfile>();

const LEGACY_TEAM_PROFILE_IDS = new Set([
  'researcher',
  'writer',
  'project-assistant',
  'cs-quality',
  'ops-analyst',
  'cc-analyzer',
]);

export const CUSTOM_BASE_PROFILE_IDS = ['default', 'team'] as const;

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
 * Load a single profile by ID (filename without extension).
 * Throws if the profile doesn't exist or is invalid.
 */
/**
 * Validate that a profile ID is safe (no path traversal or special characters).
 * Profile IDs must be alphanumeric with hyphens/underscores only.
 */
function validateProfileId(id: string): void {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid profile ID: "${id}"`);
  }
}

export function loadProfile(id: string): AgentProfile {
  validateProfileId(id);

  if (profileCache.has(id)) {
    return profileCache.get(id)!;
  }

  const filePath = join(PROFILES_DIR, `${id}.yaml`);
  if (!existsSync(filePath)) {
    throw new Error(`Profile not found: "${id}"`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  const profile = validateProfile(parsed, id);

  profileCache.set(id, profile);
  return profile;
}

/**
 * Load all available profiles from the profiles directory.
 */
export function loadAllProfiles(): AgentProfile[] {
  if (!existsSync(PROFILES_DIR)) return [];

  const files = readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const profiles: AgentProfile[] = [];
  for (const file of files) {
    const id = file.replace(/\.ya?ml$/, '');
    try {
      profiles.push(loadProfile(id));
    } catch (err) {
      logger.warn(`[Profile] ⚠️ Skipping invalid profile "${id}": ${err instanceof Error ? err.message : err}`);
    }
  }
  return profiles;
}

/**
 * List profile IDs (without loading full content).
 */
export function listProfileIds(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => f.replace(/\.ya?ml$/, ''));
}

/**
 * Get the default profile (always "default").
 */
export function getDefaultProfile(): AgentProfile {
  return loadProfile('default');
}

/**
 * Resolve profile by ID, falling back to "default" if not specified.
 * Supports custom profiles with "custom:{id}" format.
 */
export function resolveProfile(profileId?: string | null): AgentProfile {
  const normalized = normalizeProfileId(profileId);
  if (!normalized || normalized === 'default') {
    return getDefaultProfile();
  }
  // Custom profiles are resolved async — this synchronous path only handles system profiles
  return loadProfile(normalized);
}

/**
 * Resolve profile by ID, with async support for custom profiles from DB.
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

    // Load base profile for model config (fall back to default if base is invalid)
    let baseProfile: AgentProfile;
    try {
      const normalizedBase = normalizeProfileId(row.base_profile_id) ?? 'default';
      baseProfile = isValidCustomBaseProfileId(normalizedBase) ? loadProfile(normalizedBase) : loadProfile('team');
    } catch {
      baseProfile = getDefaultProfile();
    }
    const tools: string[] = JSON.parse(row.tools);
    const capabilities = JSON.parse(row.capabilities || '[]');

    return {
      id: normalized,
      name: row.name,
      description: row.description ?? undefined,
      hidden: false,
      access: {
        level: 'internal',
        requires_session: false,
        rich_output: baseProfile.access.rich_output,
      },
      model: baseProfile.model,
      tools,
      system_prompt: row.system_prompt,
      max_steps: row.max_steps,
      tool_choice: 'auto',
      capabilities: capabilities.length > 0 ? capabilities : undefined,
    };
  }

  return loadProfile(normalized);
}

/**
 * Clear the profile cache (useful for hot-reload in dev).
 */
/** Callbacks to notify when profile cache is cleared (avoids circular deps). */
const onClearCallbacks: Array<() => void> = [];

/** Register a callback that runs when the profile cache is cleared. */
export function onProfileCacheClear(cb: () => void): void {
  onClearCallbacks.push(cb);
}

/**
 * Clear the profile cache (useful for hot-reload in dev).
 */
export function clearProfileCache(): void {
  profileCache.clear();
  for (const cb of onClearCallbacks) cb();
}

// ─── Access Control Helpers (derived from profile YAML) ──

/**
 * Get profile IDs with the given access level.
 * Scans all loaded profiles — call after loadAllProfiles().
 */
export function getProfileIdsByLevel(level: AccessConfig['level']): Set<string> {
  const all = loadAllProfiles();
  return new Set(all.filter((p) => p.access.level === level).map((p) => p.id));
}

/** Profiles safe for public/anonymous access (level=public). */
export function getPublicProfileIds(): Set<string> {
  return getProfileIdsByLevel('public');
}

/** Profiles requiring session mode (admin + hidden). */
export function getAdminProfileIds(): Set<string> {
  const all = loadAllProfiles();
  return new Set(all.filter((p) => p.access.requires_session).map((p) => p.id));
}

/** Profiles that receive rich output guide. */
export function getRichOutputProfileIds(): Set<string> {
  const all = loadAllProfiles();
  return new Set(all.filter((p) => p.access.rich_output).map((p) => p.id));
}

// ─── Rich Output Prompt Enrichment ───────────────────────
//
// The rich-output rendering rules live in @greenhouse/utils/prompts so the desktop
// Pi runtime (packages/desktop-agent-runtime) can share the exact same guide —
// the frontend message component is identical across web and desktop.

/**
 * Enrich a profile's system prompt with the rich output formatting guide.
 * Applies to any profile with `access.rich_output: true` (team, desktop) — these
 * also get the confirm-button block. Default (rich_output: false) is unchanged.
 */
export function enrichSystemPrompt(profile: AgentProfile): string {
  if (!profile.access.rich_output) {
    return profile.system_prompt;
  }

  return profile.system_prompt + '\n' + composeRichOutput({ confirm: true });
}

// ─── File Watcher (dev hot-reload) ───────────────────────

let watcherActive = false;

/**
 * Start watching the profiles directory for changes.
 * On any change, clears the cache so next load picks up new content.
 * Call once at server startup in dev mode.
 */
export function startProfileWatcher(): void {
  if (watcherActive) return;
  if (!existsSync(PROFILES_DIR)) return;

  try {
    const watcher = watch(PROFILES_DIR, { persistent: false }, (eventType, filename) => {
      if (filename && (filename.endsWith('.yaml') || filename.endsWith('.yml'))) {
        const id = filename.replace(/\.ya?ml$/, '');
        profileCache.delete(id);
        logger.info(`[Profile] 🔄 Reloaded: ${id} (${eventType})`);
      }
    });

    // Don't let the watcher prevent process exit
    watcher.unref();
    watcherActive = true;
    logger.info(`[Profile] 👁️ Watching ${PROFILES_DIR} for changes`);
  } catch (err) {
    logger.warn(`[Profile] ⚠️ Could not start file watcher: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Validation ──────────────────────────────────────────

function validateProfile(raw: unknown, fileId: string): AgentProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Profile "${fileId}" is empty or not an object`);
  }

  const obj = raw as Record<string, unknown>;

  // Required fields
  const id = (obj.id as string) || fileId;
  const name = obj.name as string;
  if (!name) throw new Error(`Profile "${fileId}" missing required field: name`);

  const system_prompt = obj.system_prompt as string;
  if (!system_prompt) throw new Error(`Profile "${fileId}" missing required field: system_prompt`);

  // Model config
  const modelRaw = obj.model as Record<string, unknown> | undefined;
  if (!modelRaw) throw new Error(`Profile "${fileId}" missing required field: model`);

  const rawOpts = modelRaw.options as Record<string, unknown> | undefined;
  const modelOptions: ModelOptions | undefined = rawOpts
    ? {
        ...rawOpts,
        thinking: rawOpts.thinking as boolean | undefined,
        temperature: rawOpts.temperature as number | undefined,
        max_tokens: rawOpts.max_tokens as number | undefined,
      }
    : undefined;

  const modelId = modelRaw.id as string | undefined;

  // Optional model choices — the set of registry models the user may switch
  // between for this profile. No choices = model pinned, overrides ignored.
  const rawChoices = modelRaw.choices as Array<Record<string, unknown>> | undefined;
  let choices: ModelChoice[] | undefined;
  if (rawChoices !== undefined) {
    if (!Array.isArray(rawChoices)) {
      throw new Error(`Profile "${fileId}" model.choices must be an array`);
    }
    choices = rawChoices.map((ch) => {
      const cid = ch.id as string;
      if (!cid || !getModelEntry(cid)) {
        throw new Error(`Profile "${fileId}" model.choices references unknown registry model: "${cid}"`);
      }
      return {
        id: cid,
        label: (ch.label as string) || cid,
        ...(ch.description ? { description: ch.description as string } : {}),
      };
    });
  }

  const model: ModelConfig = {
    id: modelId,
    provider: (modelRaw.provider as string) || 'openai-compatible', // OpenAI-compatible is the only bundled protocol
    model: (modelRaw.model as string) || (modelId ?? 'default'), // placeholder when using registry id
    baseUrl: modelRaw.baseUrl as string | undefined,
    apiKey: modelRaw.apiKey as string | undefined,
    options: modelOptions,
    ...(choices ? { choices } : {}),
  };

  // Access config (declarative access control from YAML)
  const accessRaw = obj.access as Record<string, unknown> | undefined;
  const access: AccessConfig = {
    level: (accessRaw?.level as AccessConfig['level']) ?? 'internal',
    requires_session: (accessRaw?.requires_session as boolean) ?? false,
    rich_output: (accessRaw?.rich_output as boolean) ?? false,
  };

  // Tools — validate against known registry
  const tools = (obj.tools as string[]) ?? [];
  if (!Array.isArray(tools)) {
    throw new Error(`Profile "${fileId}" tools must be an array of strings`);
  }

  const unknownTools = tools.filter((t) => !KNOWN_TOOLS.has(t));
  if (unknownTools.length > 0) {
    throw new Error(
      `Profile "${fileId}" references unknown tools: ${unknownTools.join(', ')}. ` +
        `Available tools: ${[...KNOWN_TOOLS].join(', ')}`,
    );
  }

  // Capabilities (optional — for UI display)
  const rawCapabilities = obj.capabilities as Array<Record<string, unknown>> | undefined;
  const capabilities =
    rawCapabilities
      ?.map((c) => ({
        icon: (c.icon as string) || 'Lightbulb',
        label: (c.label as string) || '',
        prompt: (c.prompt as string) || '',
      }))
      .filter((c) => c.label && c.prompt) || undefined;

  return {
    id,
    name,
    description: obj.description as string | undefined,
    hidden: (obj.hidden as boolean) ?? false,
    access,
    model,
    tools,
    system_prompt,
    max_steps: (obj.max_steps as number) ?? 8,
    tool_choice: (obj.tool_choice as 'auto' | 'none' | 'required') ?? 'auto',
    capabilities,
    version: (obj.version as string) ?? undefined,
  };
}
