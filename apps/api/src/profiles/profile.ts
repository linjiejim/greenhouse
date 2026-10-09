/**
 * Agent Profile — load, validate, and resolve YAML profile definitions.
 *
 * Profiles define: identity, model config, tool subset, system prompt, and behavior.
 * Located in apps/api/src/profiles/*.yaml
 *
 * Features:
 * - YAML-based profile definitions
 * - Tool name validation against known registry
 * - In-memory cache with file watcher for dev hot-reload
 */

import { GREENHOUSE_CONFIG, resolvePackPath } from '../config/greenhouse-config.js';
import { readFileSync, readdirSync, existsSync, watch } from 'node:fs';
import { logger } from '@greenhouse/utils/logger';
import { composeRichOutput } from '@greenhouse/utils/prompts';
import { DEFAULT_CLIENT_BLOCKS } from '@greenhouse/types/rich-output';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BotRow, BotVersionRow, DatabaseProvider } from '@greenhouse/db';
import { buildFallbackIdentitySection, buildIdentitySection } from './identity-prompt.js';

// ─── Types ───────────────────────────────────────────────

// Model config types are owned by the agent kernel; re-exported here so the
// many profile consumers keep importing them from profile.js unchanged.
export type { ModelConfig, ModelOptions } from '@greenhouse/agent-core';
import type { ModelConfig, ModelOptions } from '@greenhouse/agent-core';
import { getModelEntry, getAvailableProviders } from '@greenhouse/agent-core';
import type { LocalizedText } from '@greenhouse/types/api';

export interface AccessConfig {
  level: 'internal' | 'hidden'; // access tier
  rich_output: boolean; // inject rich output formatting guide
}

/**
 * The Bot a resolved profile runs as (spec 20261007 §2.2). Present on every
 * `bot:<id>[@v]` profile and on `sprouty` when resolved for a known member
 * (their own Sprouty Bot); absent on the hidden runtimes and on a preset
 * resolved without a user, which fall back to the preset's own name.
 */
export interface ProfileIdentity {
  botId: string;
  ownerUserId: string;
  name: string;
  role: string;
  instructions: string;
  /** Avatar JSON text, as stored. */
  avatar: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  name_i18n?: LocalizedText; // per-locale copy for `name`
  description_i18n?: LocalizedText; // per-locale copy for `description`
  hidden?: boolean; // true = system-only, not shown in UI profile picker
  access: AccessConfig; // declarative access control
  model: ModelConfig;
  tools: string[]; // tool names from the registry
  /**
   * True when `tools` is a FILTER on the user's allowed set (a Bot with an
   * explicit tool list). False / absent = the user's whole allowed set; the
   * preset YAML `tools:` list is documentation, not a runtime restriction.
   */
  narrow_tools?: boolean;
  system_prompt: string;
  max_steps?: number; // default: 8
  tool_choice?: 'auto' | 'none' | 'required'; // default: "auto"
  version?: string; // last modified date (e.g. "2026-05-21")
  identity?: ProfileIdentity;
  /**
   * A Bot's connector list (`mcp_servers.slug`) — what `mcp_call` may reach.
   * Absent / null = every connector the user can use.
   */
  mcp_connectors?: string[] | null;
}

// ─── Known Tools (for validation) ────────────────────────

const KNOWN_TOOLS = new Set([
  'eval_message',
  'manage_eval_dataset',
  'analyze_image',
  'query_eval_runs',
  'external_search',
  'feature_request',
  'generate_image',
  'ask_user',
  'project_query',
  'project_mutation',
  'session_query',
  'compute',
  'knowledge_query',
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

/** The built-in presets live next to this loader (apps/api/src/profiles/*.yaml). */
const PROFILES_DIR = import.meta.dirname;

/**
 * Core profiles first, then the pack directories from greenhouse.config.ts
 * (`packs.profiles`). A later directory wins for the same id, so a pack may
 * override a built-in preset without editing core.
 */
function profileDirs(): string[] {
  return [PROFILES_DIR, ...GREENHOUSE_CONFIG.packs.profiles.map((dir) => resolvePackPath(dir))];
}

const PROFILE_FILE = /\.ya?ml$/;

/** The winning file for a profile id, or null when no directory has it. */
function findProfileFile(id: string): string | null {
  let found: string | null = null;
  for (const dir of profileDirs()) {
    for (const ext of ['yaml', 'yml']) {
      const candidate = join(dir, `${id}.${ext}`);
      if (existsSync(candidate)) found = candidate;
    }
  }
  return found;
}

// ─── Loader ──────────────────────────────────────────────

const profileCache = new Map<string, AgentProfile>();

/**
 * The one built-in agent. Model is no longer part of an agent's identity — it
 * is a per-turn choice next to the composer — so quick/deep/K3, which differed
 * ONLY by model, collapsed into this single preset (spec:
 * 20260731-attachment-and-preset-convergence M3).
 */
export const PRESET_PROFILE_IDS = ['sprouty'] as const;
export const DEFAULT_PROFILE_ID = 'sprouty';

const LEGACY_TEAM_PROFILE_IDS = new Set([
  // Collapsed into the single `sprouty` preset (2026-08-01). quick/deep/K3
  // differed only by model; `sprouty-workflows` only by model + a planner
  // prompt whose content now lives in the workflow_plan tool description.
  'sprouty-quick',
  'sprouty-deep',
  'sprouty-k3',
  'sprouty-workflows',
  'workflow-planner',
  'sprouty-agents',
  // Retired 2026-08-01: missions are dispatched from any conversation now.
  // Historical sessions keep this id; their `channel='mission'` is what still
  // drives their behavior, not the profile.
  'sprouty-mission',
  'team',
  'default',
  'researcher',
  'writer',
  'project-assistant',
  'cs-quality',
  'ops-analyst',
  'cc-analyzer',
  'crm',
]);

const LEGACY_DESKTOP_PROFILE_IDS = new Set(['local-dev', 'local-pi']);

/**
 * Map removed/legacy interactive profile IDs to their canonical replacement.
 * Stored rows (sessions, eval runs, scheduled tasks, custom bases) still carry
 * `team` / `workflow-planner` / `sprouty-agents`; they resolve to their successors
 * rather than being migrated.
 */
export function normalizeProfileId(profileId?: string | null): string | undefined {
  if (!profileId) return undefined;
  if (LEGACY_TEAM_PROFILE_IDS.has(profileId)) return DEFAULT_PROFILE_ID;
  if (LEGACY_DESKTOP_PROFILE_IDS.has(profileId)) return 'desktop';
  return profileId;
}

/**
 * Every stored id that `normalizeProfileId` resolves to this one: the id itself
 * plus the retired ids folded into it. A list filter needs them all — a
 * conversation recorded as `team` is still a Sprouty conversation.
 */
export function profileIdAliases(profileId: string): string[] {
  const retired = [...LEGACY_TEAM_PROFILE_IDS, ...LEGACY_DESKTOP_PROFILE_IDS];
  return [profileId, ...retired.filter((id) => normalizeProfileId(id) === profileId)];
}

/** A retired `custom:<id>[@v]` reference — stored rows keep them; they resolve through `bots.legacy_custom_id`. */
export interface CustomProfileReference {
  profileId: number;
  version?: number;
}

/** `bot:<id>` (follows the Bot's latest definition) or `bot:<id>@<v>` (one immutable version). */
export interface BotProfileReference {
  botId: string;
  version?: number;
}

export interface ProfileExecutionActor {
  id: string;
  role: 'team' | 'super';
}

/** Parse the retired mutable (`custom:7`) or immutable (`custom:7@3`) reference. */
export function parseCustomProfileReference(profileId: string): CustomProfileReference | null {
  const match = /^custom:(\d+)(?:@(\d+))?$/.exec(profileId);
  if (!match) return null;
  const version = match[2] ? Number(match[2]) : undefined;
  return { profileId: Number(match[1]), ...(version ? { version } : {}) };
}

export function parseBotProfileReference(profileId: string): BotProfileReference | null {
  const match = /^bot:(bot_[0-9a-f]{16})(?:@(\d+))?$/.exec(profileId);
  if (!match) return null;
  const version = match[2] ? Number(match[2]) : undefined;
  return { botId: match[1], ...(version ? { version } : {}) };
}

export function botProfileId(botId: string, version?: number | null): string {
  return version ? `bot:${botId}@${version}` : `bot:${botId}`;
}

/** Is this a Bot-backed reference (`bot:` or a retired `custom:`)? */
export function isBotProfileId(profileId: string): boolean {
  return profileId.startsWith('bot:') || profileId.startsWith('custom:');
}

/**
 * Resolve any Bot-backed reference to the Bot row it names and the version it
 * pins (if any). `custom:<id>` maps through `legacy_custom_id`. Returns null for
 * ids that are not Bot references; throws for a malformed or missing one.
 */
export async function loadBotReference(
  database: DatabaseProvider,
  profileId: string,
): Promise<{ bot: BotRow; version?: number } | null> {
  if (profileId.startsWith('custom:')) {
    const legacy = parseCustomProfileReference(profileId);
    if (!legacy) throw new Error(`Invalid custom profile ID: "${profileId}"`);
    const bot = await database.bots.getByLegacyCustomId(legacy.profileId);
    if (!bot) throw new Error(`Custom profile not found: "${profileId}"`);
    return { bot, ...(legacy.version ? { version: legacy.version } : {}) };
  }
  if (!profileId.startsWith('bot:')) return null;
  const reference = parseBotProfileReference(profileId);
  if (!reference) throw new Error(`Invalid Bot profile ID: "${profileId}"`);
  const bot = await database.bots.getBotById(reference.botId);
  if (!bot) throw new Error(`Bot not found: "${profileId}"`);
  return { bot, ...(reference.version ? { version: reference.version } : {}) };
}

/** A Bot's stored connector list (JSON text), or null = every connector the owner can use. */
export function parseBotConnectors(json: string | null | undefined): string[] | null {
  if (json == null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((slug): slug is string => typeof slug === 'string') : [];
  } catch {
    // Unreadable is not "everything": fail closed to none.
    return [];
  }
}

export function isExecutableBot(bot: Pick<BotRow, 'status'>): boolean {
  return bot.status === 'active';
}

/**
 * Build the profile a Bot runs as, on top of the base preset: the Bot owns its
 * name, instructions, optional tool filter, model and step cap; the base only
 * supplies the static rules, `rich_output` and the model FALLBACK (a model this
 * deployment cannot reach never fails a turn).
 */
export function profileFromBot(
  bot: BotRow,
  base: AgentProfile,
  opts: { id: string; version?: BotVersionRow },
): AgentProfile {
  const source = opts.version ?? bot;
  const toolsJson = source.tools;
  const tools: string[] | null = toolsJson == null ? null : (JSON.parse(toolsJson) as string[]);
  const connectors = parseBotConnectors(source.connectors);
  return {
    id: opts.id,
    name: source.name,
    description: source.description || undefined,
    hidden: false,
    access: { level: 'internal', rich_output: base.access.rich_output },
    model:
      source.model_id && getAvailableProviders(source.model_id).length > 0
        ? { ...base.model, id: source.model_id }
        : base.model,
    tools: tools ?? base.tools,
    narrow_tools: tools !== null,
    system_prompt: base.system_prompt,
    max_steps: source.max_steps ?? base.max_steps,
    tool_choice: 'auto',
    mcp_connectors: connectors,
    identity: {
      botId: bot.id,
      ownerUserId: bot.user_id,
      name: source.name,
      role: source.role,
      instructions: source.instructions,
      avatar: source.avatar,
    },
  };
}

/**
 * Revalidate a pinned Bot at the execution boundary.
 *
 * Resolving an immutable manifest proves what will run, but not whether the
 * current actor may still run it: a Bot is private to its owner (super may
 * exercise it for support). Unattended work (automations, subagents) must
 * carry a version.
 */
export async function assertPinnedProfileExecutionAccess(
  database: DatabaseProvider,
  actor: ProfileExecutionActor,
  profileId: string,
  surface = 'Agent execution',
): Promise<void> {
  const normalized = normalizeProfileId(profileId) ?? profileId;
  if (!isBotProfileId(normalized)) return;
  let loaded: Awaited<ReturnType<typeof loadBotReference>>;
  try {
    loaded = await loadBotReference(database, normalized);
  } catch {
    throw new Error(`${surface} Bot no longer exists`);
  }
  if (!loaded) return;
  if (!loaded.version) throw new Error(`${surface} Bot reference is not pinned to an immutable version`);
  const { bot, version } = loaded;
  if (!isExecutableBot(bot)) throw new Error(`${surface} Bot is not executable (${bot.status})`);
  const owns = actor.role === 'super' || bot.user_id === actor.id;
  if (!owns) throw new Error(`${surface} Bot access was revoked`);
  if (!(await database.bots.getVersion(bot.id, version))) {
    throw new Error(`${surface} Bot version no longer exists`);
  }
}

/**
 * The canonical spelling of a stored reference: a retired `custom:<id>[@v]`
 * becomes `bot:<id>[@v]` (same version number), everything else is returned
 * normalized. Used where a resolved profile's id is compared with its input.
 */
export async function canonicalizeProfileId(database: DatabaseProvider, profileId: string): Promise<string> {
  const normalized = normalizeProfileId(profileId) ?? profileId;
  if (!normalized.startsWith('custom:')) return normalized;
  const loaded = await loadBotReference(database, normalized);
  return loaded ? botProfileId(loaded.bot.id, loaded.version) : normalized;
}

/** Pin an unversioned Bot reference to its immutable current manifest. */
export async function pinProfileVersion(profileId?: string | null): Promise<string> {
  const normalized = normalizeProfileId(profileId) ?? DEFAULT_PROFILE_ID;
  if (!isBotProfileId(normalized)) return normalized;
  const { getDb } = await import('@greenhouse/db');
  const loaded = await loadBotReference(getDb(), normalized);
  if (!loaded) return normalized;
  return botProfileId(loaded.bot.id, loaded.version ?? loaded.bot.current_version);
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

function readProfileYaml(id: string): Record<string, unknown> {
  const filePath = findProfileFile(id);
  if (!filePath) {
    throw new Error(`Profile not found: "${id}"`);
  }
  return (parseYaml(readFileSync(filePath, 'utf-8')) ?? {}) as Record<string, unknown>;
}

export function loadProfile(id: string): AgentProfile {
  validateProfileId(id);

  if (profileCache.has(id)) {
    return profileCache.get(id)!;
  }

  // `extends` used to let a preset be "the same agent on another model"
  // (deep/K3 over quick). Model is a per-turn choice now, so those presets —
  // and with them the mechanism's only reason to exist — are gone (2026-08-01).
  const parsed = readProfileYaml(id);
  const profile = validateProfile(parsed, id);

  profileCache.set(id, profile);
  return profile;
}

/**
 * Load all available profiles from the profiles directory.
 */
export function loadAllProfiles(): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const id of listProfileIds()) {
    try {
      profiles.push(loadProfile(id));
    } catch (err) {
      logger.warn(`[Profile] ⚠️ Skipping invalid profile "${id}": ${err instanceof Error ? err.message : err}`);
    }
  }
  return profiles;
}

/**
 * Can this deployment actually run the profile's model?
 *
 * A model in the catalog whose `api_key_env` is unset has no reachable
 * provider, so offering the profile in the picker would buy the user nothing
 * but a "No available providers" error on their first message — exactly the
 * kind of untrue capability claim the repo bans. A preset pinned to an
 * optional catalog model (e.g. `deepseek-flash`) stays hidden until that
 * model's key is configured.
 *
 * Only system presets are gated on this: a *custom* agent is user data, and
 * silently dropping someone's agent from their own list reads as data loss.
 */
export function isProfileRunnable(profile: AgentProfile): boolean {
  return !profile.model.id || getAvailableProviders(profile.model.id).length > 0;
}

/**
 * List profile IDs (without loading full content).
 */
export function listProfileIds(): string[] {
  const ids = new Set<string>();
  for (const dir of profileDirs()) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) if (PROFILE_FILE.test(file)) ids.add(file.replace(PROFILE_FILE, ''));
  }
  return [...ids];
}

/**
 * Get the default internal profile.
 */
export function getDefaultProfile(): AgentProfile {
  return loadProfile(DEFAULT_PROFILE_ID);
}

/**
 * Resolve a system profile by ID, falling back to the default preset only when
 * omitted. Removed IDs normalize to Sprouty for stored-data compatibility.
 * Custom references must use resolveProfileAsync(); this function rejects them.
 */
export function resolveProfile(profileId?: string | null): AgentProfile {
  const normalized = normalizeProfileId(profileId);
  if (!normalized || normalized === DEFAULT_PROFILE_ID) {
    return getDefaultProfile();
  }
  if (isBotProfileId(normalized)) {
    throw new Error(`Bot profile requires async resolution: "${normalized}"`);
  }
  return loadProfile(normalized);
}

export interface ResolveProfileOptions {
  /**
   * The member the profile runs for. With it, the default preset resolves to
   * the member's own Sprouty Bot (identity, instructions, model, tool filter),
   * created on first use. Without it, `sprouty` is the bare preset.
   */
  forUserId?: string | null;
}

/**
 * Resolve profile by ID, with async support for Bot-backed profiles from the DB.
 * Use this instead of resolveProfile() when `bot:` / `custom:` IDs may be passed.
 */
export async function resolveProfileAsync(
  profileId?: string | null,
  database?: DatabaseProvider,
  options: ResolveProfileOptions = {},
): Promise<AgentProfile> {
  const normalized = normalizeProfileId(profileId);
  if (!normalized || normalized === DEFAULT_PROFILE_ID) {
    const base = getDefaultProfile();
    if (!options.forUserId) return base;
    // The member's Sprouty Bot is the default identity (spec 20261007 D6):
    // renaming or re-instructing it in Bots changes every Chat session too.
    // The id stays `sprouty` so usage attribution and the picker's default
    // handle never fragment per member.
    const db = database ?? (await import('@greenhouse/db')).getDb();
    const { ensureSproutyBot } = await import('../bots/sprouty.js');
    const bot = await ensureSproutyBot(db, options.forUserId);
    return profileFromBot(bot, base, { id: DEFAULT_PROFILE_ID });
  }

  if (isBotProfileId(normalized)) {
    // Reject malformed IDs before loading the full DB provider graph. Besides
    // avoiding needless work on bad requests, this keeps the pure validation
    // path fast in CLI startup and tests.
    if (normalized.startsWith('bot:') && !parseBotProfileReference(normalized)) {
      throw new Error(`Invalid Bot profile ID: "${normalized}"`);
    }
    if (normalized.startsWith('custom:') && !parseCustomProfileReference(normalized)) {
      throw new Error(`Invalid custom profile ID: "${normalized}"`);
    }
    const db = database ?? (await import('@greenhouse/db')).getDb();
    // Never silently substitute another Bot: that changes identity, tools,
    // instructions and cost policy while presenting the missing Bot's id.
    const loaded = await loadBotReference(db, normalized);
    if (!loaded) throw new Error(`Invalid profile ID: "${normalized}"`);
    const { bot } = loaded;
    if (!isExecutableBot(bot)) {
      throw new Error(`Bot is not executable (${bot.status}): "${normalized}"`);
    }
    let version: BotVersionRow | undefined;
    if (loaded.version) {
      version = await db.bots.getVersion(bot.id, loaded.version);
      if (!version) throw new Error(`Bot version not found: "${botProfileId(bot.id, loaded.version)}"`);
    }
    return profileFromBot(bot, getDefaultProfile(), {
      id: botProfileId(bot.id, loaded.version),
      ...(version ? { version } : {}),
    });
  }

  return loadProfile(normalized);
}

/**
 * Clear the profile cache (useful for hot-reload in dev).
 */
export function clearProfileCache(): void {
  profileCache.clear();
}

// ─── Rich Output Prompt Enrichment ───────────────────────
//
// The rich-output rendering rules live in @greenhouse/utils/prompts so every server
// profile that opts in gets the same frontend-compatible formatting guide.

/** Per-turn inputs to {@link enrichSystemPrompt}. */
export interface EnrichOptions {
  /** The member this turn runs for — named in the identity section ("You work for …"). */
  nickname?: string | null;
  /**
   * The Rich Output blocks the requesting screen can draw. Omitted for every
   * headless path (automations, workflows, sub-sessions), whose output is read
   * on the web: those get the default set.
   */
  richBlocks?: readonly string[];
}

/**
 * Enrich a profile's system prompt: the identity section first (the Bot's
 * name, role and instructions, or the preset's own name when no Bot backs it),
 * then the static rules, then the rich output formatting guide for profiles
 * with `access.rich_output: true` — only the blocks the client can draw.
 * Hidden runtimes (`access.level: hidden`) carry their own complete prompt.
 */
export function enrichSystemPrompt(profile: AgentProfile, options: EnrichOptions = {}): string {
  const parts: string[] = [];
  if (profile.identity) {
    parts.push(buildIdentitySection(profile.identity, options.nickname));
  } else if (profile.access.level !== 'hidden' && !profile.hidden) {
    parts.push(buildFallbackIdentitySection(profile.name));
  }
  parts.push(profile.system_prompt);
  if (profile.access.rich_output)
    parts.push(composeRichOutput({ blocks: options.richBlocks ?? DEFAULT_CLIENT_BLOCKS }));
  return parts.join('\n\n');
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
  for (const dir of profileDirs()) {
    if (existsSync(dir)) watchProfileDir(dir);
  }
}

function watchProfileDir(dir: string): void {
  try {
    const watcher = watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename && (filename.endsWith('.yaml') || filename.endsWith('.yml'))) {
        const id = filename.replace(/\.ya?ml$/, '');
        profileCache.delete(id);
        logger.info(`[Profile] 🔄 Reloaded: ${id} (${eventType})`);
      }
    });
    // Some macOS development hosts can exhaust the global watcher pool while
    // several worktrees are running. fs.watch reports that condition
    // asynchronously, outside the try/catch above; keep hot reload optional
    // instead of crashing the API process.
    watcher.on('error', (err) => {
      watcher.close();
      watcherActive = false;
      logger.warn(`[Profile] ⚠️ File watcher stopped: ${err instanceof Error ? err.message : String(err)}`);
    });

    // fs.watch failures (e.g. EMFILE under system-wide watcher exhaustion)
    // surface as an async 'error' EVENT, not a sync throw — without this
    // handler the event is unhandled and kills the whole process. Hot-reload
    // is a dev convenience; losing it must never take the api down.
    watcher.on('error', (err) => {
      watcherActive = false;
      logger.warn(`[Profile] ⚠️ Profile watcher stopped: ${err instanceof Error ? err.message : String(err)}`);
      try {
        watcher.close();
      } catch {
        /* already dead */
      }
    });

    // Don't let the watcher prevent process exit
    watcher.unref();
    watcherActive = true;
    logger.info(`[Profile] 👁️ Watching ${dir} for changes`);
  } catch (err) {
    logger.warn(`[Profile] ⚠️ Could not start file watcher: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Localized Display Text ──────────────────────────────
//
// Any display-facing YAML string may be written either as a plain string (source
// language, no translation) or as a per-locale map:
//
//   description: 内部团队助手 — 深度调研…
//   description:
//     zh: 内部团队助手 — 深度调研…
//     en: Internal team assistant — deep research…
//
// Parsing keeps BOTH forms: `flat` (always the source locale) so every existing
// consumer — logs, admin views, the external API — behaves exactly as before, and
// `i18n` for clients that want to render in the user's locale.

/** Locales a profile may declare copy for. Mirrors the web app's `Locale` union. */
const SUPPORTED_LOCALES = ['en', 'zh'] as const;

/** Locale the YAML profiles are authored in — the fallback when a translation is missing. */
const SOURCE_LOCALE: (typeof SUPPORTED_LOCALES)[number] = 'zh';

interface ParsedLocalized {
  flat: string;
  i18n?: LocalizedText;
}

/**
 * Parse `string | { en?, zh? }` into a flat source-locale string plus an optional
 * locale map. Unknown locale keys and non-string values throw — a typo like `cn:`
 * would otherwise silently ship untranslated copy to users.
 */
function parseLocalized(raw: unknown, fileId: string, field: string): ParsedLocalized {
  if (raw === undefined || raw === null) return { flat: '' };
  if (typeof raw === 'string') return { flat: raw };

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Profile "${fileId}" field "${field}" must be a string or a locale map`);
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  const i18n: LocalizedText = {};
  for (const [locale, value] of entries) {
    if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
      throw new Error(
        `Profile "${fileId}" field "${field}" has unsupported locale "${locale}". ` +
          `Supported locales: ${SUPPORTED_LOCALES.join(', ')}`,
      );
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Profile "${fileId}" field "${field}.${locale}" must be a non-empty string`);
    }
    i18n[locale as keyof LocalizedText] = value;
  }

  // Flat value = source locale, or any declared locale when the source is absent.
  const flat = i18n[SOURCE_LOCALE] ?? Object.values(i18n)[0] ?? '';
  if (!flat) throw new Error(`Profile "${fileId}" field "${field}" is an empty locale map`);

  return { flat, i18n };
}

// ─── Validation ──────────────────────────────────────────

/** Exported for tests — production code reaches this through `loadProfile`. */
export function validateProfile(raw: unknown, fileId: string): AgentProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Profile "${fileId}" is empty or not an object`);
  }

  const obj = raw as Record<string, unknown>;

  // Required fields
  const id = (obj.id as string) || fileId;
  const name = parseLocalized(obj.name, fileId, 'name');
  if (!name.flat) throw new Error(`Profile "${fileId}" missing required field: name`);

  const description = parseLocalized(obj.description, fileId, 'description');

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
  // Registry profiles declare only `model.id`; `provider` is then whatever the
  // catalog says runs it. It used to be hard-coded to 'deepseek', which the
  // admin panel then displayed for every model whatever actually served it.
  // The runtime never reads this field for registry profiles
  // (createModelFromConfig resolves by `id`), so it must not lie either.
  const registryProvider = modelId ? getModelEntry(modelId)?.providers[0]?.provider : undefined;

  const model: ModelConfig = {
    id: modelId,
    provider: (modelRaw.provider as string) || registryProvider || 'openai-compatible', // last resort: legacy default
    model: (modelRaw.model as string) || (modelId ? modelId : 'flash'), // placeholder when using registry
    baseUrl: modelRaw.baseUrl as string | undefined,
    apiKey: modelRaw.apiKey as string | undefined,
    options: modelOptions,
  };

  // Access config (declarative access control from YAML)
  const accessRaw = obj.access as Record<string, unknown> | undefined;
  const accessLevel = (accessRaw?.level as string | undefined) ?? 'internal';
  if (!['internal', 'hidden'].includes(accessLevel)) {
    throw new Error(`Profile "${fileId}" has invalid access.level: "${accessLevel}"`);
  }
  const access: AccessConfig = {
    level: accessLevel as AccessConfig['level'],
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

  return {
    id,
    name: name.flat,
    description: description.flat || undefined,
    ...(name.i18n ? { name_i18n: name.i18n } : {}),
    ...(description.i18n ? { description_i18n: description.i18n } : {}),
    hidden: (obj.hidden as boolean) ?? false,
    access,
    model,
    tools,
    system_prompt,
    max_steps: (obj.max_steps as number) ?? 8,
    tool_choice: (obj.tool_choice as 'auto' | 'none' | 'required') ?? 'auto',
    version: (obj.version as string) ?? undefined,
  };
}
