/**
 * Profile routes — /api/profiles
 *
 * GET  /api/profiles                  — the identities the caller may run: the member's own Sprouty (as
 *                                       `sprouty`), their other Bots and the Bots other members published
 *                                       (`bot:<id>`), plus the per-turn model list
 * GET  /api/profiles/:id              — 获取 Profile 详情（含 24h/7d 分时段用量，super）
 * POST /api/profiles/reload           — 清除缓存并重新加载所有 Profile 配置（super）
 * GET  /api/profiles/usage/summary    — 全局 LLM 用量汇总（按 profile/caller 维度，super）
 *
 * Bot management (create / edit / versions / lifecycle / sharing) lives under
 * /api/bots (bots/routes.ts) — a Bot is the one agent identity
 * (docs/specs/20261007-agent-bot-convergence.md).
 */

import { Hono } from 'hono';
import {
  DEFAULT_PROFILE_ID,
  PRESET_PROFILE_IDS,
  botProfileId,
  clearProfileCache,
  isProfileRunnable,
  loadAllProfiles,
  normalizeProfileId,
  resolveProfileAsync,
  type AgentProfile,
} from '../profiles/profile.js';
import { getModelEntry } from '@greenhouse/agent-core';
import { listChatModels } from '../config/models.js';
import { getDb } from '@greenhouse/db';
import type { BotRow, BotVersionRow, DatabaseProvider } from '@greenhouse/db';
import { isSproutyBot } from '@greenhouse/types/bots';
import { getAuthUser, requireSuper } from '../auth/middleware.js';
import { assertBotProfileAccess, ProfileAccessError } from '../profiles/access.js';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AppEnv } from '../app-env.js';
import { withOwnerNicknames } from '../user-display.js';
import { normalizeProfileAvatar } from '../profiles/avatar.js';
import { ensureSproutyBot } from '../bots/sprouty.js';

// ─── Helpers ─────────────────────────────────────────────

interface ProfileUsageView {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_reasoning_tokens: number;
  avg_duration_ms: number;
  last_used_at: string | null;
}

type UsageStat = Awaited<ReturnType<DatabaseProvider['usage']['getStatsByProfile']>>[number];

function usageView(u: UsageStat | undefined): ProfileUsageView | null {
  return u
    ? {
        total_calls: u.total_calls,
        total_input_tokens: u.total_input_tokens,
        total_output_tokens: u.total_output_tokens,
        total_cached_tokens: u.total_cached_tokens,
        total_reasoning_tokens: u.total_reasoning_tokens,
        avg_duration_ms: u.avg_duration_ms,
        last_used_at: u.last_used_at,
      }
    : null;
}

/** The display model of a Bot: its own catalog entry, else the base preset's. */
function displayModel(modelId: string | null, base: AgentProfile): { provider: string; model: string } {
  const own = modelId ? getModelEntry(modelId)?.providers[0]?.provider : undefined;
  return own && modelId
    ? { provider: own, model: modelId }
    : { provider: base.model.provider, model: base.model.model };
}

/**
 * A Bot as a picker entry. The manifest shown is the version the caller may
 * run: owners see the current definition, others the published version.
 */
function formatBotProfile(bot: BotRow, base: AgentProfile, version?: BotVersionRow) {
  const manifest = version ?? bot;
  const tools = manifest.tools == null ? null : (safeJsonParse(manifest.tools, []) as string[]);
  return {
    id: botProfileId(bot.id),
    bot_id: bot.id,
    name: manifest.name,
    description: manifest.description || manifest.role || null,
    role: manifest.role,
    // null tools = the owner's whole allowed set; the picker shows the list only when narrowed.
    tools: tools ?? [],
    tools_inherited: tools === null,
    system_prompt: manifest.instructions,
    max_steps: manifest.max_steps ?? base.max_steps,
    is_custom: true,
    is_shared: bot.is_shared,
    user_id: bot.user_id,
    forked_from: bot.forked_from,
    template_key: bot.template_key,
    created_at: bot.created_at,
    updated_at: bot.updated_at,
    lifecycle_status: bot.lifecycle_status,
    lifecycle_note: bot.lifecycle_note,
    current_version: bot.current_version,
    published_version: bot.published_version,
    next_review_at: bot.next_review_at,
    avatar: normalizeProfileAvatar(safeJsonParse(manifest.avatar, {})),
    model_id: manifest.model_id ?? base.model.id ?? 'flash',
    model: displayModel(manifest.model_id, base),
  };
}

/** The member's Sprouty Bot as the default entry: the preset's handle, the Bot's face and name. */
function formatSproutyProfile(preset: AgentProfile, bot: BotRow) {
  return {
    id: preset.id,
    bot_id: bot.id,
    name: bot.name,
    description: bot.description || preset.description,
    role: bot.role,
    // Member-named: the preset's localized copy no longer applies to the name.
    name_i18n: undefined,
    description_i18n: bot.description ? undefined : preset.description_i18n,
    model: displayModel(bot.model_id, preset),
    model_id: bot.model_id ?? preset.model.id,
    tools: bot.tools == null ? preset.tools : (safeJsonParse(bot.tools, []) as string[]),
    tools_inherited: bot.tools == null,
    max_steps: bot.max_steps ?? preset.max_steps,
    tool_choice: preset.tool_choice,
    system_prompt: bot.instructions,
    avatar: normalizeProfileAvatar(safeJsonParse(bot.avatar, {})),
    is_custom: false,
    template_key: bot.template_key,
  };
}

const profiles = new Hono<AppEnv>()
  // ─── Usage Summary ───────────────────────────────────────

  /** GET /api/profiles/usage/summary — global usage summary */
  .use('/usage/summary', requireSuper())
  .get('/usage/summary', async (c) => {
    const since = c.req.query('since') || undefined;
    const db = getDb();
    const opts = since ? { since } : undefined;

    const [byProfile, byCaller, total] = await Promise.all([
      db.usage.getStatsByProfile(opts),
      db.usage.getStatsByCaller(opts),
      db.usage.getTotalStats(opts),
    ]);

    return c.json({
      by_profile: byProfile.map((s) => ({
        profile_id: s.profile_id,
        calls: s.total_calls,
        input_tokens: s.total_input_tokens,
        output_tokens: s.total_output_tokens,
        avg_duration_ms: s.avg_duration_ms,
        last_used_at: s.last_used_at,
      })),
      by_caller: byCaller.map((s) => ({
        caller: s.caller,
        calls: s.total_calls,
        input_tokens: s.total_input_tokens,
        output_tokens: s.total_output_tokens,
      })),
      total,
      period: { since: since ?? null },
    });
  })
  // ─── The picker ──────────────────────────────────────────

  /** GET /api/profiles — the identities the caller may run + the per-turn models */
  .get('/', async (c) => {
    const authUser = getAuthUser(c);
    const db = getDb();
    let all = loadAllProfiles();

    // Hidden system profiles are resolved only by their dedicated server-side
    // integration routes; they never appear in the interactive profile API.
    all = all.filter((p) => !p.hidden && p.access.level !== 'hidden');

    // …and neither does a preset this deployment cannot actually run (its
    // model has no provider key in env) — see isProfileRunnable.
    all = all.filter(isProfileRunnable);

    const usageStats = await db.usage.getStatsByProfile();
    const usageMap = new Map(usageStats.map((s) => [s.profile_id, s]));

    // Presets lead, in their declared order: the list is what the picker renders,
    // so "which agent do I meet first" is a product decision, not an artifact of
    // tool counts or filenames.
    const presetRank = (id: string) => {
      const i = (PRESET_PROFILE_IDS as readonly string[]).indexOf(id);
      return i === -1 ? PRESET_PROFILE_IDS.length : i;
    };
    all.sort((a, b) => presetRank(a.id) - presetRank(b.id) || a.tools.length - b.tools.length);

    // The member's Sprouty Bot IS the default identity (spec 20261007 D6): the
    // `sprouty` entry carries its name and face, created on first use.
    const sprouty = await ensureSproutyBot(db, authUser.id);
    const base = all.find((p) => p.id === DEFAULT_PROFILE_ID) ?? all[0];
    const systemProfiles = all.map((p) => ({
      ...(p.id === DEFAULT_PROFILE_ID
        ? formatSproutyProfile(p, sprouty)
        : {
            id: p.id,
            name: p.name,
            description: p.description,
            name_i18n: p.name_i18n,
            description_i18n: p.description_i18n,
            model: { provider: p.model.provider, model: p.model.model },
            model_id: p.model.id,
            tools: p.tools,
            max_steps: p.max_steps,
            tool_choice: p.tool_choice,
            system_prompt: p.system_prompt,
            is_custom: false,
          }),
      usage: usageView(usageMap.get(p.id)),
    }));

    // The member's other Bots (their current definition) and the Bots other
    // members published (their reviewed version only). Super's governance queue
    // is intentionally confined to /api/admin/bots: this list feeds the picker.
    const mine = (await db.bots.listBots(authUser.id)).filter((bot) => !isSproutyBot(bot));
    const shared = await db.bots.listShared(authUser.id);
    const botProfiles: Array<ReturnType<typeof formatBotProfile> & { usage: ProfileUsageView | null }> = [];
    if (base) {
      for (const bot of mine) {
        botProfiles.push({ ...formatBotProfile(bot, base), usage: usageView(usageMap.get(botProfileId(bot.id))) });
      }
      for (const bot of shared) {
        const version = bot.published_version ? await db.bots.getVersion(bot.id, bot.published_version) : undefined;
        if (!version) continue;
        botProfiles.push({ ...formatBotProfile(bot, base, version), usage: null });
      }
    }

    return c.json({
      profiles: [...systemProfiles, ...(await withOwnerNicknames(db, botProfiles, authUser.id))],
      // The models a user may switch between per turn. Filtered to those with a
      // reachable provider, so a deployment without DEEPSEEK_API_KEY simply never
      // offers `deepseek-flash`.
      models: listChatModels(),
    });
  })
  /** GET /api/profiles/:id — get profile detail with time-bucketed usage */
  .use('/:id', requireSuper())
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const normalizedId = normalizeProfileId(id) ?? id;
    try {
      await assertBotProfileAccess(getAuthUser(c), normalizedId);
      const profile = await resolveProfileAsync(id);
      if (profile.access.level === 'hidden') return c.json({ error: `Profile not found: ${id}` }, 404);
      const db = getDb();

      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [total, last24h, last7d, recentCalls] = await Promise.all([
        db.usage.getProfileStats(normalizedId),
        db.usage.getProfileStats(normalizedId, { since: since24h }),
        db.usage.getProfileStats(normalizedId, { since: since7d }),
        db.usage.getRecentUsage(normalizedId, 20),
      ]);

      return c.json({
        profile,
        usage: {
          total: total
            ? {
                calls: total.total_calls,
                input_tokens: total.total_input_tokens,
                output_tokens: total.total_output_tokens,
                cached_tokens: total.total_cached_tokens,
                reasoning_tokens: total.total_reasoning_tokens,
                avg_duration_ms: total.avg_duration_ms,
                last_used_at: total.last_used_at,
              }
            : null,
          last_24h: last24h
            ? {
                calls: last24h.total_calls,
                input_tokens: last24h.total_input_tokens,
                output_tokens: last24h.total_output_tokens,
              }
            : null,
          last_7d: last7d
            ? {
                calls: last7d.total_calls,
                input_tokens: last7d.total_input_tokens,
                output_tokens: last7d.total_output_tokens,
              }
            : null,
        },
        recent_calls: recentCalls,
      });
    } catch (err) {
      if (err instanceof ProfileAccessError) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: `Profile not found: ${id}` }, 404);
    }
  })
  /** POST /api/profiles/reload — clear cache and reload */
  .post('/reload', (c) => {
    // Cache reload is operational tooling — super only (any authed user could
    // otherwise thrash the profile cache)
    if (getAuthUser(c).role !== 'super') {
      return c.json({ error: 'Forbidden' }, 403);
    }
    clearProfileCache();
    const all = loadAllProfiles();
    return c.json({ reloaded: all.length });
  });

export default profiles;
