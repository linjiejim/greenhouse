/**
 * Team context + monthly retro admin — super only (mounted under /api/admin).
 *
 * GET  /api/admin/team-context   — the picked conventions / glossary (with why a pick no
 *                                  longer serves), the workspace time zone, team documents
 *                                  to pick from, and when the retro runs next
 * PUT  /api/admin/team-context   — { conventions: string[], glossary: string|null, timezone?: string|null }
 *                                  every picked doc must be a published team document;
 *                                  written as workspace settings (`team_context.*`)
 * POST /api/admin/retro          — { month?: 'YYYY-MM' } write (or update) that month's retro
 *                                  now; default = the current month ("生成本月复盘")
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import {
  DEFAULT_WORKSPACE_TIMEZONE,
  type RetroResult,
  type TeamContextSettingsInput,
  type TeamContextSettingsView,
} from '@greenhouse/types/hub-context';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { applyWorkspaceSettingValues } from './admin-settings.js';
import {
  readTeamContextConfig,
  resolveTeamContextDocs,
  validateTeamContextSelection,
} from '../hub-context/settings.js';
import { monthlyRetroNextRun, startMonthlyRetroJob } from '../scheduler/upkeep-jobs.js';
import { generateMonthlyRetro, RetroInputError } from '../retro/generate.js';

const CANDIDATE_LIMIT = 500;

async function settingsView(): Promise<TeamContextSettingsView> {
  const db = getDb();
  const config = await readTeamContextConfig();
  const [resolved, candidates] = await Promise.all([
    resolveTeamContextDocs(db, config),
    db.knowledgeBase.list({ scope: 'shared', status: 'published', visibility: 'team', limit: CANDIDATE_LIMIT }),
  ]);
  return {
    conventions: resolved.refs.conventions,
    glossary: resolved.refs.glossary,
    timezone: config.timezone,
    effective_timezone: config.timezone ?? DEFAULT_WORKSPACE_TIMEZONE,
    candidates: candidates.filter((doc) => !doc.is_template).map((doc) => ({ doc_id: doc.doc_id, title: doc.title })),
    retro_next_run_at: monthlyRetroNextRun()?.toISOString() ?? null,
  };
}

function parseInput(body: unknown): TeamContextSettingsInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.conventions) || record.conventions.some((id) => typeof id !== 'string')) return null;
  if (record.glossary !== null && typeof record.glossary !== 'string') return null;
  if (record.timezone !== undefined && record.timezone !== null && typeof record.timezone !== 'string') return null;
  return {
    conventions: [...new Set((record.conventions as string[]).map((id) => id.trim()).filter(Boolean))],
    glossary: typeof record.glossary === 'string' && record.glossary.trim() ? record.glossary.trim() : null,
    ...(record.timezone !== undefined ? { timezone: (record.timezone as string | null)?.trim() || null } : {}),
  };
}

export const adminTeamContextRoutes = new Hono<AppEnv>()
  .get('/', async (c) => c.json(await settingsView()))
  .put('/', async (c) => {
    const user = getAuthUser(c);
    const input = parseInput(await c.req.json().catch(() => null));
    if (!input) {
      return c.json(
        { error: 'Body must be { conventions: string[], glossary: string | null, timezone?: string | null }' },
        400,
      );
    }
    const checked = await validateTeamContextSelection(getDb(), input);
    if (!checked.ok) return c.json({ error: checked.error }, 400);

    const before = await readTeamContextConfig();
    const values: Record<string, unknown> = {
      'team_context.conventions': input.conventions.length > 0 ? input.conventions : null,
      'team_context.glossary': input.glossary,
    };
    if (input.timezone !== undefined) values['team_context.timezone'] = input.timezone;
    const applied = await applyWorkspaceSettingValues(user, c, values);
    if (!applied.ok) return c.json({ error: applied.error }, applied.status);

    // The retro runs at 09:00 workspace time: follow a zone change at once.
    if (input.timezone !== undefined && input.timezone !== before.timezone) await startMonthlyRetroJob();
    return c.json(await settingsView());
  });

export const adminRetroRoutes = new Hono<AppEnv>().post('/', async (c) => {
  const user = getAuthUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { month?: unknown };
  if (body.month !== undefined && typeof body.month !== 'string') {
    return c.json({ error: 'month must be YYYY-MM' }, 400);
  }
  try {
    const result: RetroResult = await generateMonthlyRetro({
      db: getDb(),
      ...(typeof body.month === 'string' ? { month: body.month } : {}),
      actorId: user.id,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RetroInputError) return c.json({ error: err.message }, 400);
    throw err;
  }
});
