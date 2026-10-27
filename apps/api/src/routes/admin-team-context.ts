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
import { fromExtensions } from '../plugin-host/index.js';
import { teamContextDocumentSources } from '../hub-context/settings.js';

async function settingsView(): Promise<TeamContextSettingsView> {
  const db = getDb();
  const config = await readTeamContextConfig();
  const [resolved, candidates] = await Promise.all([
    resolveTeamContextDocs(db, config),
    Promise.all(teamContextDocumentSources().map((source) => source.candidates(db))).then((rows) => rows.flat()),
  ]);
  return {
    markdown: { overview: config.overview, conventions: config.conventionsMarkdown, glossary: config.glossaryMarkdown },
    document_source: teamContextDocumentSources().length > 0,
    conventions: resolved.refs.conventions,
    glossary: resolved.refs.glossary,
    timezone: config.timezone,
    effective_timezone: config.timezone ?? DEFAULT_WORKSPACE_TIMEZONE,
    candidates: candidates,
    retro_next_run_at:
      fromExtensions('schedules')
        .map((schedule) => schedule.nextRun())
        .find(Boolean)
        ?.toISOString() ?? null,
  };
}

function parseInput(body: unknown): TeamContextSettingsInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    record.markdown !== undefined &&
    (!record.markdown || typeof record.markdown !== 'object' || Array.isArray(record.markdown))
  )
    return null;
  const hasSelection = record.conventions !== undefined || record.glossary !== undefined;
  if (hasSelection && (!Array.isArray(record.conventions) || record.conventions.some((id) => typeof id !== 'string')))
    return null;
  if (hasSelection && record.glossary !== null && typeof record.glossary !== 'string') return null;
  if (record.timezone !== undefined && record.timezone !== null && typeof record.timezone !== 'string') return null;
  return {
    ...(record.markdown && typeof record.markdown === 'object'
      ? { markdown: record.markdown as TeamContextSettingsInput['markdown'] }
      : {}),
    ...(hasSelection
      ? {
          conventions: [...new Set((record.conventions as string[]).map((id) => id.trim()).filter(Boolean))],
          glossary: typeof record.glossary === 'string' && record.glossary.trim() ? record.glossary.trim() : null,
        }
      : {}),
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
    const checked = input.conventions
      ? await validateTeamContextSelection(getDb(), {
          conventions: input.conventions,
          glossary: input.glossary ?? null,
        })
      : { ok: true as const };
    if (!checked.ok) return c.json({ error: checked.error }, 400);

    const before = await readTeamContextConfig();
    const values: Record<string, unknown> = {
      ...(teamContextDocumentSources().length && input.conventions
        ? {
            'team_context.conventions': input.conventions.length > 0 ? input.conventions : null,
            'team_context.glossary': input.glossary ?? null,
          }
        : {}),
    };
    if (input.markdown)
      for (const key of ['overview', 'conventions', 'glossary'] as const) {
        if (typeof input.markdown[key] !== 'string')
          return c.json({ error: 'Markdown context must contain text' }, 400);
        values[`team_context.${key}_markdown`] = input.markdown[key] || null;
      }
    if (input.timezone !== undefined) values['team_context.timezone'] = input.timezone;
    const applied = await applyWorkspaceSettingValues(user, c, values);
    if (!applied.ok) return c.json({ error: applied.error }, applied.status);

    // The retro runs at 09:00 workspace time: follow a zone change at once.
    if (input.timezone !== undefined && input.timezone !== before.timezone)
      await Promise.all(fromExtensions('workspaceTimeZoneChanged').map((change) => change()));
    return c.json(await settingsView());
  });
