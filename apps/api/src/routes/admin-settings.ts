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
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getWorkspaceSettingDef } from '@greenhouse/types/workspace-settings';
import { getAuthUser } from '../auth/middleware.js';
import { encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import {
  getWorkspaceSettingViews,
  refreshWorkspaceConfig,
  validateWorkspaceValue,
} from '../settings/workspace-config.js';
import type { AppEnv } from '../app-env.js';

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

    // Validate everything before writing anything — a batch is all-or-nothing.
    const clears: string[] = [];
    const writes: Array<{ key: string; secret: boolean; value: unknown }> = [];
    for (const [key, raw] of Object.entries(body.values)) {
      const def = getWorkspaceSettingDef(key);
      if (!def) return c.json({ error: `Unknown setting: ${key}` }, 400);
      if (raw === null || raw === '') {
        clears.push(key);
        continue;
      }
      const result = validateWorkspaceValue(def, raw);
      if (!result.ok) return c.json({ error: result.error }, 400);
      if (def.secret && !isEncryptionConfigured()) {
        return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured' }, 503);
      }
      writes.push({ key, secret: def.secret ?? false, value: result.value });
    }

    for (const key of clears) await getDb().workspaceSettings.clear(key);
    for (const w of writes) {
      await getDb().workspaceSettings.set(
        w.key,
        w.secret ? { value_enc: encryptToken(String(w.value)) } : { value: w.value },
        user.id,
      );
    }

    await refreshWorkspaceConfig();
    return c.json({ settings: await getWorkspaceSettingViews() });
  });

export default adminSettingsRoutes;
