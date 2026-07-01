/**
 * Profile routes — /api/profiles
 *
 * GET  /api/profiles                  — 获取所有可用 Profile 列表（系统 + 自定义，含 usage）
 * GET  /api/profiles/custom           — 列出当前用户的自定义 Profile + 他人共享的
 * POST /api/profiles/custom           — 创建自定义 Profile
 * POST /api/profiles/custom/fork      — Fork 一个系统或自定义 Profile
 * GET  /api/profiles/custom/:id       — 获取自定义 Profile 详情
 * PUT  /api/profiles/custom/:id       — 更新自定义 Profile
 * DELETE /api/profiles/custom/:id     — 删除自定义 Profile
 * GET  /api/profiles/:id              — 获取 Profile 详情（含 24h/7d 分时段用量）
 * POST /api/profiles/reload           — 清除缓存并重新加载所有 Profile 配置
 * GET  /api/profiles/usage/summary    — 全局 LLM 用量汇总（按 profile/caller 维度）
 *
 * Validation is driven by `profileManifestSchema` (the single source of truth);
 * tool access + is_shared remain permission-checked here.
 */

import { Hono } from 'hono';
import {
  CUSTOM_BASE_PROFILE_IDS,
  clearProfileCache,
  isValidCustomBaseProfileId,
  loadAllProfiles,
  normalizeProfileId,
  resolveProfileAsync,
  type AgentProfile,
} from '../profile.js';
import { profileManifestSchema, type ProfileData } from '@greenhouse/types/profile-manifest';
import { getDb } from '@greenhouse/db';
import type { CustomProfileRow } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { getAllToolIds, getGlobalToolIds } from '../tools/registry.js';
import { sanitizeForPrompt } from '../security.js';
import { logger } from '@greenhouse/utils/logger';
import type { AppEnv } from '../app-env.js';

const MAX_CUSTOM_PROFILES_PER_USER = 20;

// ─── Helpers ─────────────────────────────────────────────

/** Generate a URL-safe slug from a name. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9一-鿿-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'profile'
  );
}

/** Get all valid custom base profile IDs. Removed preset profiles are never custom bases. */
function getValidBaseIds(): string[] {
  return [...CUSTOM_BASE_PROFILE_IDS];
}

/** Strip the relational columns off a manifest, leaving the jsonb `data` payload (system prompt sanitized). */
function manifestToData(m: ReturnType<typeof profileManifestSchema.parse>): ProfileData {
  const { slug: _slug, name: _name, base_profile_id: _bp, ...rest } = m;
  return { ...rest, system_prompt: sanitizeForPrompt(rest.system_prompt) };
}

/** Validate tool names against the registry + the user's allowed set. Returns an error string or null. */
async function checkTools(tools: string[], authUser: { id: string; role: string }): Promise<string | null> {
  const allTools = getAllToolIds();
  const invalid = tools.filter((t) => !allTools.includes(t));
  if (invalid.length > 0) return `Unknown tools: ${invalid.join(', ')}`;
  if (authUser.role !== 'super') {
    const globalTools = getGlobalToolIds();
    const assignedTools = await getDb().userTools.getTools(authUser.id);
    const userAllowed = new Set([...globalTools, ...assignedTools]);
    const unauthorized = tools.filter((t) => !userAllowed.has(t));
    if (unauthorized.length > 0) return `You don't have access to these tools: ${unauthorized.join(', ')}`;
  }
  return null;
}

/**
 * Validate model_choice_ids ⊆ the base profile's switchable choices. Returns an
 * error string or null. Empty/undefined means "inherit all base choices" and is
 * always valid. Without this, unknown ids are silently dropped at resolve time
 * (and an all-invalid selection would collapse the switcher to no choices).
 */
function checkModelChoices(choiceIds: string[] | undefined, baseId: string): string | null {
  if (!choiceIds || choiceIds.length === 0) return null;
  const base = loadAllProfiles().find((p) => p.id === baseId);
  const baseChoices = base?.model.choices ?? [];
  if (baseChoices.length === 0) {
    return `Base profile "${baseId}" has a fixed model and offers no model choices to select`;
  }
  const valid = new Set(baseChoices.map((ch) => ch.id));
  const invalid = choiceIds.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    return `Invalid model choices: ${invalid.join(', ')}. Available: ${baseChoices.map((ch) => ch.id).join(', ')}`;
  }
  return null;
}

/** Format a custom profile row for API response, deriving model config from base profile. */
function formatCustomProfile(row: CustomProfileRow, baseProfileMap?: Map<string, AgentProfile>) {
  const data = row.data;
  // Derive model config (incl. switchable choices) from base profile
  let model: { provider: string; model: string } | undefined;
  let modelChoices: Array<{ id: string; label: string; description?: string }> = [];
  if (baseProfileMap) {
    const base = baseProfileMap.get(row.base_profile_id || 'default') ?? baseProfileMap.get('default');
    if (base) {
      model = { provider: base.model.provider, model: base.model.model };
      const baseChoices = base.model.choices ?? [];
      // Effective choices = base ∩ user-selected (empty selection → inherit all base choices).
      modelChoices =
        data.model_choice_ids && data.model_choice_ids.length > 0
          ? baseChoices.filter((c) => data.model_choice_ids!.includes(c.id))
          : baseChoices;
    }
  }
  return {
    id: `custom:${row.id}`,
    slug: row.slug,
    name: row.name,
    description: data.description ?? null,
    base_profile_id: row.base_profile_id,
    tools: data.tools,
    system_prompt: data.system_prompt,
    capabilities: data.capabilities ?? [],
    max_steps: data.max_steps,
    tool_choice: data.tool_choice,
    is_shared: row.is_shared,
    is_custom: true,
    user_id: row.user_id,
    forked_from: row.forked_from || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    avatar: data.avatar ?? {},
    model_options: data.model_options ?? {},
    model_choice_ids: data.model_choice_ids ?? [],
    default_language: data.default_language ?? null,
    greeting: data.greeting ?? null,
    suggested_followups: data.suggested_followups ?? [],
    model_choices: modelChoices,
    ...(model ? { model } : {}),
  };
}

const profiles = new Hono<AppEnv>()
  // ─── Usage Summary ───────────────────────────────────────

  /** GET /api/profiles/usage/summary — global usage summary */
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
  // ─── Custom Profile CRUD ─────────────────────────────────

  /** GET /api/profiles/custom — list custom profiles for current user */
  .get('/custom', async (c) => {
    const authUser = getAuthUser(c);
    if (authUser.role === 'external') {
      return c.json({ error: 'External users cannot use custom profiles' }, 403);
    }

    const rows = await getDb().customProfiles.listForUser(authUser.id);
    const baseMap = new Map(loadAllProfiles().map((p) => [p.id, p]));
    const formatted = rows.map((r) => formatCustomProfile(r, baseMap));

    // Attach usage stats
    const usagePromises = formatted.map((p) => getDb().usage.getProfileStats(p.id));
    const usages = await Promise.all(usagePromises);
    for (let i = 0; i < formatted.length; i++) {
      const u = usages[i];
      (formatted[i] as any).usage = u
        ? {
            total_calls: u.total_calls,
            total_input_tokens: u.total_input_tokens,
            total_output_tokens: u.total_output_tokens,
            avg_duration_ms: u.avg_duration_ms,
            last_used_at: u.last_used_at,
          }
        : null;
    }

    return c.json({ profiles: formatted });
  })
  /** POST /api/profiles/custom — create a custom profile */
  .post('/custom', async (c) => {
    const authUser = getAuthUser(c);
    if (authUser.role === 'external') {
      return c.json({ error: 'External users cannot create custom profiles' }, 403);
    }

    const body = await c.req.json();
    const parsed = profileManifestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid profile' }, 400);
    }
    const m = parsed.data;

    // Validate base profile
    const validBases = getValidBaseIds();
    const baseId = normalizeProfileId(m.base_profile_id) || 'default';
    if (!isValidCustomBaseProfileId(baseId)) {
      return c.json({ error: `Invalid base profile: ${baseId}. Must be one of: ${validBases.join(', ')}` }, 400);
    }

    // Validate tools are within registry + the user's allowed set
    const toolError = await checkTools(m.tools, authUser);
    if (toolError) return c.json({ error: toolError }, toolError.startsWith('Unknown') ? 400 : 403);

    // Validate model choices are offered by the base profile
    const choiceError = checkModelChoices(m.model_choice_ids, baseId);
    if (choiceError) return c.json({ error: choiceError }, 400);

    // Only super can share
    const shared = authUser.role === 'super' ? Boolean(body.is_shared) : false;

    // Check limit
    const count = await getDb().customProfiles.countByUser(authUser.id);
    if (count >= MAX_CUSTOM_PROFILES_PER_USER) {
      return c.json({ error: `Maximum ${MAX_CUSTOM_PROFILES_PER_USER} custom profiles per user` }, 400);
    }

    const slug = slugify(m.name);

    try {
      const row = await getDb().customProfiles.create({
        slug,
        user_id: authUser.id,
        name: m.name,
        base_profile_id: baseId,
        is_shared: shared,
        data: manifestToData(m),
      });

      logger.info(`[Profile] ✅ Custom profile created: custom:${row.id} (${row.name}) by ${authUser.id}`);
      return c.json(formatCustomProfile(row), 201);
    } catch (err: any) {
      if (err.message?.includes('uq_custom_profiles_user_slug') || err.code === '23505') {
        return c.json({ error: `A profile with slug "${slug}" already exists` }, 409);
      }
      throw err;
    }
  })
  /** POST /api/profiles/custom/fork — fork a system or custom profile */
  .post('/custom/fork', async (c) => {
    const authUser = getAuthUser(c);
    if (authUser.role === 'external') {
      return c.json({ error: 'External users cannot create custom profiles' }, 403);
    }

    const body = await c.req.json();
    const { source_profile_id, name } = body;

    if (!source_profile_id || typeof source_profile_id !== 'string') {
      return c.json({ error: 'source_profile_id is required' }, 400);
    }

    // Load source profile into a manifest-data payload
    let sourceData: ProfileData;
    let sourceName: string;
    let baseProfileId: string;

    if (source_profile_id.startsWith('custom:')) {
      // Fork from another custom profile
      const customId = parseInt(source_profile_id.slice(7), 10);
      if (isNaN(customId)) {
        return c.json({ error: 'Invalid source custom profile ID' }, 400);
      }
      const sourceRow = await getDb().customProfiles.getById(customId);
      if (!sourceRow) {
        return c.json({ error: 'Source custom profile not found' }, 404);
      }
      // Access check: must be owner or shared
      if (sourceRow.user_id !== authUser.id && !sourceRow.is_shared && authUser.role !== 'super') {
        return c.json({ error: 'Access denied to source profile' }, 403);
      }
      sourceData = sourceRow.data;
      sourceName = sourceRow.name;
      baseProfileId = isValidCustomBaseProfileId(normalizeProfileId(sourceRow.base_profile_id) ?? '')
        ? (normalizeProfileId(sourceRow.base_profile_id) as string)
        : 'team';
    } else {
      // Fork from system profile
      const allProfiles = loadAllProfiles();
      const source = allProfiles.find((p) => p.id === source_profile_id && !p.hidden);
      if (!source) {
        return c.json({ error: `Source system profile not found: ${source_profile_id}` }, 404);
      }
      sourceData = {
        system_prompt: source.system_prompt,
        tools: source.tools,
        max_steps: source.max_steps ?? 12,
        tool_choice: source.tool_choice ?? 'auto',
        capabilities: source.capabilities ?? [],
      };
      sourceName = source.name;
      baseProfileId = isValidCustomBaseProfileId(source.id) ? source.id : 'team'; // preset forks use team model config
    }

    // Filter tools to only those the user has access to
    const globalTools = getGlobalToolIds();
    let userAllowed: Set<string>;
    if (authUser.role === 'super') {
      userAllowed = new Set(getAllToolIds());
    } else {
      const assignedTools = await getDb().userTools.getTools(authUser.id);
      userAllowed = new Set([...globalTools, ...assignedTools]);
    }
    const effectiveTools = sourceData.tools.filter((t) => userAllowed.has(t));

    // Check profile count limit
    const count = await getDb().customProfiles.countByUser(authUser.id);
    if (count >= MAX_CUSTOM_PROFILES_PER_USER) {
      return c.json({ error: `Maximum ${MAX_CUSTOM_PROFILES_PER_USER} custom profiles per user` }, 400);
    }

    // Generate name and slug
    const forkName = name?.trim() || `${sourceName} (Fork)`;
    const slug = slugify(forkName);

    try {
      const row = await getDb().customProfiles.create({
        slug,
        user_id: authUser.id,
        name: forkName,
        base_profile_id: baseProfileId,
        is_shared: false,
        forked_from: source_profile_id,
        data: { ...sourceData, tools: effectiveTools, description: `Forked from ${source_profile_id}` },
      });

      logger.info(
        `[Profile] ⚙️ Custom profile forked: custom:${row.id} (${row.name}) from ${source_profile_id} by ${authUser.id}`,
      );
      const baseMap = new Map(loadAllProfiles().map((p) => [p.id, p]));
      return c.json(formatCustomProfile(row, baseMap), 201);
    } catch (err: any) {
      if (err.message?.includes('uq_custom_profiles_user_slug') || err.code === '23505') {
        return c.json({ error: `A profile with slug "${slug}" already exists. Try a different name.` }, 409);
      }
      throw err;
    }
  })
  /** GET /api/profiles/custom/:id — get custom profile detail */
  .get('/custom/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid profile ID' }, 400);

    const row = await getDb().customProfiles.getById(id);
    if (!row) return c.json({ error: 'Custom profile not found' }, 404);

    // Access control: owner or super
    if (row.user_id !== authUser.id && authUser.role !== 'super' && !row.is_shared) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const baseMap = new Map(loadAllProfiles().map((p) => [p.id, p]));
    return c.json(formatCustomProfile(row, baseMap));
  })
  /** PUT /api/profiles/custom/:id — update custom profile */
  .put('/custom/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid profile ID' }, 400);

    const row = await getDb().customProfiles.getById(id);
    if (!row) return c.json({ error: 'Custom profile not found' }, 404);

    // Only owner or super can update
    if (row.user_id !== authUser.id && authUser.role !== 'super') {
      return c.json({ error: 'Access denied' }, 403);
    }

    const body = await c.req.json();
    // Merge the patch onto the current manifest, then validate the whole thing.
    // (Full-merge avoids partial-schema default landmines: an absent key keeps
    // its current value instead of being reset to a schema default.)
    const current = { name: row.name, base_profile_id: row.base_profile_id, ...row.data };
    const parsed = profileManifestSchema.safeParse({ ...current, ...body });
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid profile' }, 400);
    }
    const m = parsed.data;

    const baseId = normalizeProfileId(m.base_profile_id) || 'default';
    if (!isValidCustomBaseProfileId(baseId)) {
      return c.json(
        { error: `Invalid base profile: ${m.base_profile_id}. Must be one of: ${getValidBaseIds().join(', ')}` },
        400,
      );
    }

    const toolError = await checkTools(m.tools, authUser);
    if (toolError) return c.json({ error: toolError }, toolError.startsWith('Unknown') ? 400 : 403);

    const choiceError = checkModelChoices(m.model_choice_ids, baseId);
    if (choiceError) return c.json({ error: choiceError }, 400);

    const updates: Parameters<ReturnType<typeof getDb>['customProfiles']['update']>[1] = {
      name: m.name,
      base_profile_id: baseId,
      data: manifestToData(m),
    };
    // is_shared is privileged (super only) and not part of the manifest
    if (body.is_shared !== undefined && authUser.role === 'super') {
      updates.is_shared = Boolean(body.is_shared);
    }

    const updated = await getDb().customProfiles.update(id, updates);
    if (!updated) return c.json({ error: 'Update failed' }, 500);

    logger.info(`[Profile] ✏️ Custom profile updated: custom:${id} by ${authUser.id}`);
    const baseMap = new Map(loadAllProfiles().map((p) => [p.id, p]));
    return c.json(formatCustomProfile(updated, baseMap));
  })
  /** DELETE /api/profiles/custom/:id — delete custom profile */
  .delete('/custom/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid profile ID' }, 400);

    const row = await getDb().customProfiles.getById(id);
    if (!row) return c.json({ error: 'Custom profile not found' }, 404);

    // Only owner or super can delete
    if (row.user_id !== authUser.id && authUser.role !== 'super') {
      return c.json({ error: 'Access denied' }, 403);
    }

    await getDb().customProfiles.delete(id);
    logger.info(`[Profile] 🗑️ Custom profile deleted: custom:${id} (${row.name}) by ${authUser.id}`);
    return c.json({ success: true });
  })
  // ─── System Profile Routes ───────────────────────────────

  /** GET /api/profiles — list available profiles (system + custom, filtered by user access) */
  .get('/', async (c) => {
    const authUser = getAuthUser(c);
    let all = loadAllProfiles();

    // Super/team see all public + internal profiles; external sees public only
    if (authUser.role === 'external') {
      all = all.filter((p) => p.access.level === 'public');
    }
    // Super and team both see all non-hidden profiles (hidden filtered below)

    // Filter out hidden (system-only) profiles.
    all = all.filter((p) => !p.hidden);

    const usageStats = await getDb().usage.getStatsByProfile();
    const usageMap = new Map(usageStats.map((s) => [s.profile_id, s]));

    // Sort by tools count ascending (simpler profiles first)
    all.sort((a, b) => a.tools.length - b.tools.length);

    const systemProfiles = all.map((p) => {
      const u = usageMap.get(p.id);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        model: { provider: p.model.provider, model: p.model.model },
        model_choices: p.model.choices ?? [],
        tools: p.tools,
        max_steps: p.max_steps,
        tool_choice: p.tool_choice,
        system_prompt: p.system_prompt,
        capabilities: p.capabilities || [],
        is_custom: false,
        usage: u
          ? {
              total_calls: u.total_calls,
              total_input_tokens: u.total_input_tokens,
              total_output_tokens: u.total_output_tokens,
              total_cached_tokens: u.total_cached_tokens,
              total_reasoning_tokens: u.total_reasoning_tokens,
              avg_duration_ms: u.avg_duration_ms,
              last_used_at: u.last_used_at,
            }
          : null,
      };
    });

    // Append custom profiles for internal users
    // (typed element — an `any[]` here would collapse the whole route's
    // inferred response to `never` and break the hc contract)
    let customProfilesList: Array<
      ReturnType<typeof formatCustomProfile> & { usage: (typeof systemProfiles)[number]['usage'] }
    > = [];
    if (authUser.role !== 'external') {
      const customRows = await getDb().customProfiles.listForUser(authUser.id);
      const baseMap = new Map(all.map((p) => [p.id, p]));
      customProfilesList = customRows.map((r) => {
        const formatted = formatCustomProfile(r, baseMap);
        const u = usageMap.get(formatted.id);
        return {
          ...formatted,
          usage: u
            ? {
                total_calls: u.total_calls,
                total_input_tokens: u.total_input_tokens,
                total_output_tokens: u.total_output_tokens,
                total_cached_tokens: u.total_cached_tokens,
                total_reasoning_tokens: u.total_reasoning_tokens,
                avg_duration_ms: u.avg_duration_ms,
                last_used_at: u.last_used_at,
              }
            : null,
        };
      });
    }

    return c.json({
      profiles: [...systemProfiles, ...customProfilesList],
    });
  })
  /** GET /api/profiles/:id — get profile detail with time-bucketed usage */
  .get('/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = c.req.param('id');
    const normalizedId = normalizeProfileId(id) ?? id;
    try {
      const profile = await resolveProfileAsync(id);
      if (profile.access.level === 'hidden') {
        return c.json({ error: `Profile not found: ${id}` }, 404);
      }
      if (authUser.role === 'external' && profile.access.level !== 'public') {
        return c.json({ error: `Profile not found: ${id}` }, 404);
      }
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
    } catch {
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
