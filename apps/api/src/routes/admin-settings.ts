/**
 * Workspace settings admin endpoints — /api/admin/settings (super only).
 *
 * GET /            all registry settings as masked views (secrets expose
 *                  has_value/source only, never the value)
 * PUT /            { values: { [key]: value | null } } — validate + upsert;
 *                  null or '' clears the row (falls back to the env var).
 *                  Secrets are AES-256-GCM encrypted at rest; after a write
 *                  the resolved values are re-overlaid onto process.env so
 *                  call-time consumers pick them up without a restart.
 *                  Every effective change records a platform audit event
 *                  (`updateWorkspaceSettings`) with the key names only —
 *                  never a value, secret or not.
 */

import { Hono, type Context } from 'hono';
import { getDb } from '@greenhouse/db';
import { getWorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
import { getAuthUser } from '../auth/middleware.js';
import { humanActor } from '../platform/actor.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import { encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import {
  getWorkspaceSettingViews,
  refreshWorkspaceConfig,
  validateWorkspaceValue,
} from '../settings/workspace-config.js';
import type { AppEnv } from '../app-env.js';

/**
 * Validate and write a batch of workspace settings, all-or-nothing, with one
 * platform audit event naming the keys (never a value). `null` / `''` clears
 * a row. Shared by this route and Administration › Team context.
 */
export async function applyWorkspaceSettingValues(
  actor: { id: string },
  c: Context,
  values: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; status: 400 | 503; error: string }> {
  // Validate everything before writing anything — a batch is all-or-nothing.
  const clears: string[] = [];
  const writes: Array<{ key: string; secret: boolean; value: unknown }> = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = getWorkspaceSettingDef(key);
    if (!def) return { ok: false, status: 400, error: `Unknown setting: ${key}` };
    if (raw === null || raw === '') {
      clears.push(key);
      continue;
    }
    const result = validateWorkspaceValue(def, raw);
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    if (def.secret && !isEncryptionConfigured()) {
      return { ok: false, status: 503, error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured' };
    }
    writes.push({ key, secret: def.secret ?? false, value: result.value });
  }

  for (const key of clears) await getDb().workspaceSettings.clear(key);
  for (const w of writes) {
    await getDb().workspaceSettings.set(
      w.key,
      w.secret ? { value_enc: encryptToken(String(w.value)) } : { value: w.value },
      actor.id,
    );
  }

  if (writes.length > 0 || clears.length > 0) {
    // Key names only: the values include LLM / media / search credentials.
    await getDb().platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: actor.id,
      actorType: 'human',
      requestId: humanActor(actor, c).requestId,
      resource: { appId: 'platform', moduleId: 'settings', entityId: 'workspaceSetting' },
      actionId: 'updateWorkspaceSettings',
      capability: 'platform.settings.manage',
      result: 'success',
      summary: {
        set: writes.map((w) => w.key),
        cleared: clears,
        secret_keys: writes.filter((w) => w.secret).map((w) => w.key),
      },
    });
  }

  await refreshWorkspaceConfig();
  return { ok: true };
}

const adminSettingsRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    return c.json({ settings: await getWorkspaceSettingViews() });
  })
  .put('/', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as { values?: Record<string, unknown> };
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      return c.json({ error: 'Body must be { values: { [key]: value | null } }' }, 400);
    }
    const applied = await applyWorkspaceSettingValues(user, c, body.values);
    if (!applied.ok) return c.json({ error: applied.error }, applied.status);
    return c.json({ settings: await getWorkspaceSettingViews() });
  });

export default adminSettingsRoutes;
