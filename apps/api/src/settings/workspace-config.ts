/**
 * Workspace config — resolution, env overlay and validation for the
 * `workspace_settings` table (registry: @greenhouse/types/workspace-settings).
 *
 * Resolution order per setting: DB row → env var (`def.env`) → unset.
 *
 * ─── Env overlay ─────────────────────────────────────────
 * Every consumer of the runtime keys (agent-core model factory, media tools,
 * external search) reads `process.env` at CALL time. Instead of threading a
 * settings service through all of them (and into @greenhouse/agent-core,
 * which must stay DB-free), `applyWorkspaceEnvOverlay()` materializes the
 * effective values onto `process.env`:
 *
 *   • at startup (after initDatabase, before the tool registry / scheduler)
 *   • after every admin settings write (refreshWorkspaceConfig)
 *
 * The pre-overlay env values are snapshotted once so clearing a DB row
 * restores the env fallback. Single-process assumption — matches the
 * supported docker-compose deploy; multi-node needs a restart (see spec).
 *
 * Secrets are stored AES-256-GCM-encrypted (auth/crypto.ts, same
 * PROVIDER_TOKEN_ENCRYPTION_KEY path as llm_upstreams) and are never returned
 * by the admin read API (has_value/source only).
 */

import {
  WORKSPACE_SETTINGS,
  getWorkspaceSettingDef,
  sanitizeThemeTokens,
  LOGO_ALLOWED_MIME,
  LOGO_MAX_DATA_URL_LENGTH,
  type WorkspaceSettingDef,
  type WorkspaceSettingView,
  type WorkspaceSettingSource,
  type WorkspaceBootstrap,
  type ThemeTokens,
} from '@greenhouse/types/workspace-settings';
import { avatarConfigSchema } from '@greenhouse/types/profile-manifest';
import { getDb, isDbInitialized } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { decryptToken } from '../auth/crypto.js';

// ─── State ───────────────────────────────────────────────

/** Resolved DB values (secrets decrypted), keyed by registry key. */
let cache: Map<string, unknown> | null = null;

/** Pre-overlay env values for every registry `env` var (undefined = unset). */
const envSnapshot = new Map<string, string | undefined>();

function snapshotEnv(envVar: string): void {
  if (!envSnapshot.has(envVar)) envSnapshot.set(envVar, process.env[envVar]);
}

/** The env var's ORIGINAL (pre-overlay) value — overlay writes make live
 *  process.env reads useless for "is there an env fallback?" questions. */
function originalEnv(envVar: string): string | undefined {
  snapshotEnv(envVar);
  return envSnapshot.get(envVar);
}

// ─── DB load / cache ─────────────────────────────────────

async function loadDbValues(): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  const rows = await getDb().workspaceSettings.list();
  for (const row of rows) {
    const def = getWorkspaceSettingDef(row.key);
    if (!def) continue; // stale key from an older registry — ignore
    if (def.secret) {
      if (!row.value_enc) continue;
      try {
        map.set(row.key, decryptToken(row.value_enc));
      } catch (err) {
        // Wrong/rotated PROVIDER_TOKEN_ENCRYPTION_KEY — treat as unset rather
        // than taking the whole config (and startup) down.
        logger.warn(`[WorkspaceConfig] Cannot decrypt ${row.key} (key rotated?): ${toErrorMessage(err)}`);
      }
    } else if (row.value !== null) {
      map.set(row.key, row.value);
    }
  }
  return map;
}

async function ensureCache(): Promise<Map<string, unknown>> {
  if (!cache) cache = await loadDbValues();
  return cache;
}

export function invalidateWorkspaceConfigCache(): void {
  cache = null;
}

// ─── Resolution ──────────────────────────────────────────

/** Effective value: DB → original env → undefined. */
export async function getWorkspaceValue(key: string): Promise<unknown> {
  const def = getWorkspaceSettingDef(key);
  if (!def) return undefined;
  const db = (await ensureCache()).get(key);
  if (db !== undefined) return db;
  if (def.env) {
    const env = originalEnv(def.env);
    if (env !== undefined && env !== '') return env;
  }
  return undefined;
}

// ─── Env overlay ─────────────────────────────────────────

/**
 * Materialize effective values onto process.env for every env-mapped setting.
 * Safe to call before initDatabase (snapshots only, no overlay).
 */
export async function applyWorkspaceEnvOverlay(): Promise<void> {
  // Snapshot first so originals survive the overlay writes below.
  for (const def of WORKSPACE_SETTINGS) if (def.env) snapshotEnv(def.env);
  if (!isDbInitialized()) return;

  const db = await ensureCache();
  let applied = 0;
  for (const def of WORKSPACE_SETTINGS) {
    if (!def.env) continue;
    const dbVal = db.get(def.key);
    if (dbVal !== undefined && dbVal !== '') {
      process.env[def.env] = String(dbVal);
      applied++;
    } else {
      // Restore the pre-overlay state (set or unset).
      const orig = envSnapshot.get(def.env);
      if (orig === undefined) delete process.env[def.env];
      else process.env[def.env] = orig;
    }
  }
  if (applied > 0) logger.info(`[WorkspaceConfig] ${applied} setting(s) overlaid onto process.env`);
}

/** Invalidate + re-resolve + re-overlay — call after every settings write. */
export async function refreshWorkspaceConfig(): Promise<void> {
  invalidateWorkspaceConfigCache();
  await applyWorkspaceEnvOverlay();
}

// ─── Validation (write path) ─────────────────────────────

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string };

const DATA_URL_RE = /^data:([a-z0-9.+/-]+);base64,[A-Za-z0-9+/=]+$/i;

/**
 * Validate + canonicalize one value against its registry def. `null` /
 * empty-string are handled by the caller as "clear" and never reach here.
 */
export function validateWorkspaceValue(def: WorkspaceSettingDef, raw: unknown): ValidationResult {
  const maxLength = def.maxLength ?? 2000;

  if (def.type === 'string' || def.type === 'text') {
    if (typeof raw !== 'string') return { ok: false, error: `${def.key} must be a string` };
    const value = raw.trim();
    if (value.length > maxLength) return { ok: false, error: `${def.key} exceeds ${maxLength} characters` };

    if (def.key === 'branding.logo') {
      const match = DATA_URL_RE.exec(value);
      if (!match) return { ok: false, error: 'branding.logo must be a base64 data URL' };
      if (!(LOGO_ALLOWED_MIME as readonly string[]).includes(match[1].toLowerCase()))
        return { ok: false, error: `branding.logo mime must be one of: ${LOGO_ALLOWED_MIME.join(', ')}` };
      if (value.length > LOGO_MAX_DATA_URL_LENGTH) return { ok: false, error: 'branding.logo exceeds 256 KB' };
    }
    if (def.key.endsWith('base_url')) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
      } catch {
        return { ok: false, error: `${def.key} must be a valid http(s) URL` };
      }
    }
    return { ok: true, value };
  }

  // type === 'json'
  const serialized = JSON.stringify(raw);
  if (!serialized || serialized.length > maxLength)
    return { ok: false, error: `${def.key} exceeds ${maxLength} characters` };

  if (def.key === 'branding.theme_tokens') {
    const tokens = sanitizeThemeTokens(raw);
    if (!tokens) return { ok: false, error: 'branding.theme_tokens has no valid token entries' };
    return { ok: true, value: tokens };
  }
  if (def.key === 'branding.team_avatar') {
    const parsed = avatarConfigSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `branding.team_avatar: ${parsed.error.issues[0]?.message}` };
    return { ok: true, value: parsed.data };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${def.key} must be a JSON object` };
  return { ok: true, value: raw };
}

// ─── Views (admin read) ──────────────────────────────────

export async function getWorkspaceSettingViews(): Promise<WorkspaceSettingView[]> {
  const db = await ensureCache();
  return WORKSPACE_SETTINGS.map((def) => {
    const hasDb = db.has(def.key);
    let source: WorkspaceSettingSource = 'none';
    if (hasDb) source = 'db';
    else if (def.env && (originalEnv(def.env) ?? '') !== '') source = 'env';
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      description: def.description,
      type: def.type,
      secret: def.secret ?? false,
      env: def.env ?? null,
      value: !def.secret && hasDb ? db.get(def.key) : null,
      has_value: hasDb,
      source,
    };
  });
}

// ─── Bootstrap payload (public, pre-login) ───────────────

/** Non-sensitive personalization for GET /api/bootstrap. Fails open to
 *  defaults — the login page must render even if the DB is unreachable. */
export async function getWorkspaceBootstrap(): Promise<WorkspaceBootstrap> {
  try {
    const productName = (await getWorkspaceValue('branding.product_name')) as string | undefined;
    const logo = (await getWorkspaceValue('branding.logo')) as string | undefined;
    const tokens = await getWorkspaceValue('branding.theme_tokens');
    const avatar = await getWorkspaceValue('branding.team_avatar');
    return {
      product_name: productName || null,
      logo: logo || null,
      // Sanitize on the way out too — a tampered DB row must not be able to
      // break out of the <style> block the web injects.
      theme_tokens: (tokens ? sanitizeThemeTokens(tokens) : null) as ThemeTokens | null,
      team_avatar: avatar ? (avatarConfigSchema.safeParse(avatar).data ?? null) : null,
    };
  } catch (err) {
    logger.warn(`[WorkspaceConfig] bootstrap fell back to defaults: ${toErrorMessage(err)}`);
    return { product_name: null, logo: null, theme_tokens: null, team_avatar: null };
  }
}
