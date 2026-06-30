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
import { getDb } from '@greenhouse/db';
import type { CustomProfileRow } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import { getAllToolIds, getGlobalToolIds } from '../tools/registry.js';
import { sanitizeForPrompt } from '../security.js';
import { logger } from '@greenhouse/utils/logger';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AppEnv } from '../app-env.js';

const MAX_CUSTOM_PROFILES_PER_USER = 20;

// ─── Helpers ─────────────────────────────────────────────

/** Generate a URL-safe slug from a name. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'profile'
  );
}

/** Get all valid custom base profile IDs. Removed preset profiles are never custom bases. */
function getValidBaseIds(): string[] {
  return [...CUSTOM_BASE_PROFILE_IDS];
}

/** Format a custom profile row for API response, deriving model config from base profile. */
function formatCustomProfile(row: CustomProfileRow, baseProfileMap?: Map<string, AgentProfile>) {
  // Derive model config (incl. switchable choices) from base profile
  let model: { provider: string; model: string } | undefined;
  let modelChoices: Array<{ id: string; label: string; description?: string }> = [];
  if (baseProfileMap) {
    const base = baseProfileMap.get(row.base_profile_id || 'default') ?? baseProfileMap.get('default');
    if (base) {
      model = { provider: base.model.provider, model: base.model.model };
      modelChoices = base.model.choices ?? [];
    }
  }
  return {
    id: `custom:${row.id}`,
    slug: row.slug,
    name: row.name,
    description: row.description,
    base_profile_id: row.base_profile_id,
    tools: safeJsonParse(row.tools, []) as string[],
    system_prompt: row.system_prompt,
    capabilities: safeJsonParse(row.capabilities, []) as Array<{ icon: string; label: string; prompt: string }>,
    max_steps: row.max_steps,
    is_shared: row.is_shared,
    is_custom: true,
    user_id: row.user_id,
    forked_from: row.forked_from || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    avatar: safeJsonParse(row.avatar, {}),
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
    const { name, description, base_profile_id, tools, system_prompt, capabilities, max_steps, is_shared, avatar } =
      body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return c.json({ error: 'Name is required' }, 400);
    }
    if (!system_prompt || typeof system_prompt !== 'string' || system_prompt.trim().length === 0) {
      return c.json({ error: 'System prompt is required' }, 400);
    }
    if (system_prompt.trim().length > 8000) {
      return c.json({ error: 'System prompt must be 8000 characters or less' }, 400);
    }
    if (!Array.isArray(tools)) {
      return c.json({ error: 'Tools must be an array' }, 400);
    }

    // Validate base profile exists
    const validBases = getValidBaseIds();
    const baseId = normalizeProfileId(base_profile_id || 'default') || 'default';
    if (!isValidCustomBaseProfileId(baseId)) {
      return c.json({ error: `Invalid base profile: ${baseId}. Must be one of: ${validBases.join(', ')}` }, 400);
    }

    // Validate tools are within user's allowed set
    const allTools = getAllToolIds();
    const invalidTools = tools.filter((t: string) => !allTools.includes(t));
    if (invalidTools.length > 0) {
      return c.json({ error: `Unknown tools: ${invalidTools.join(', ')}` }, 400);
    }

    // Check if user has access to the requested tools
    if (authUser.role !== 'super') {
      const globalTools = getGlobalToolIds();
      const assignedTools = await getDb().userTools.getTools(authUser.id);
      const userAllowed = new Set([...globalTools, ...assignedTools]);
      const unauthorized = tools.filter((t: string) => !userAllowed.has(t));
      if (unauthorized.length > 0) {
        return c.json({ error: `You don't have access to these tools: ${unauthorized.join(', ')}` }, 403);
      }
    }

    // Only super can set is_shared
    const shared = authUser.role === 'super' ? (is_shared ?? false) : false;

    // Check limit
    const count = await getDb().customProfiles.countByUser(authUser.id);
    if (count >= MAX_CUSTOM_PROFILES_PER_USER) {
      return c.json({ error: `Maximum ${MAX_CUSTOM_PROFILES_PER_USER} custom profiles per user` }, 400);
    }

    // Generate slug
    const slug = slugify(name.trim());

    try {
      const row = await getDb().customProfiles.create({
        slug,
        user_id: authUser.id,
        name: name.trim(),
        description: description?.trim() || undefined,
        base_profile_id: baseId,
        tools,
        system_prompt: sanitizeForPrompt(system_prompt.trim()),
        capabilities: capabilities || [],
        max_steps: max_steps || 12,
        is_shared: shared,
        avatar: avatar || {},
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

    // Load source profile
    let sourcePrompt: string;
    let sourceTools: string[];
    let sourceCapabilities: Array<{ icon: string; label: string; prompt: string }>;
    let sourceMaxSteps: number;
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
      sourcePrompt = sourceRow.system_prompt;
      sourceTools = safeJsonParse(sourceRow.tools, []) as string[];
      sourceCapabilities = safeJsonParse(sourceRow.capabilities, []) as Array<{
        icon: string;
        label: string;
        prompt: string;
      }>;
      sourceMaxSteps = sourceRow.max_steps;
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
      sourcePrompt = source.system_prompt;
      sourceTools = source.tools;
      sourceCapabilities = source.capabilities || [];
      sourceMaxSteps = source.max_steps ?? 12;
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
    const effectiveTools = sourceTools.filter((t) => userAllowed.has(t));

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
        description: `Forked from ${source_profile_id}`,
        base_profile_id: baseProfileId,
        tools: effectiveTools,
        system_prompt: sourcePrompt,
        capabilities: sourceCapabilities,
        max_steps: sourceMaxSteps,
        is_shared: false,
        forked_from: source_profile_id,
      });

      logger.info(
        `[Profile] \u2699\uFE0F Custom profile forked: custom:${row.id} (${row.name}) from ${source_profile_id} by ${authUser.id}`,
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

    return c.json(formatCustomProfile(row));
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
    const updates: any = {};

    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description?.trim() || null;
    if (body.base_profile_id !== undefined) {
      const normalizedBase = normalizeProfileId(body.base_profile_id);
      if (!normalizedBase || !isValidCustomBaseProfileId(normalizedBase)) {
        return c.json(
          { error: `Invalid base profile: ${body.base_profile_id}. Must be one of: ${getValidBaseIds().join(', ')}` },
          400,
        );
      }
      updates.base_profile_id = normalizedBase;
    }
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) return c.json({ error: 'Tools must be an array' }, 400);
      const allTools = getAllToolIds();
      const invalidTools = body.tools.filter((t: string) => !allTools.includes(t));
      if (invalidTools.length > 0) {
        return c.json({ error: `Unknown tools: ${invalidTools.join(', ')}` }, 400);
      }
      // Validate user has access to these tools
      if (authUser.role !== 'super') {
        const globalTools = getGlobalToolIds();
        const assignedTools = await getDb().userTools.getTools(authUser.id);
        const userAllowed = new Set([...globalTools, ...assignedTools]);
        const unauthorized = body.tools.filter((t: string) => !userAllowed.has(t));
        if (unauthorized.length > 0) {
          return c.json({ error: `You don't have access to these tools: ${unauthorized.join(', ')}` }, 403);
        }
      }
      updates.tools = body.tools;
    }
    if (body.system_prompt !== undefined) {
      if (typeof body.system_prompt !== 'string' || body.system_prompt.trim().length === 0) {
        return c.json({ error: 'System prompt cannot be empty' }, 400);
      }
      if (body.system_prompt.trim().length > 8000) {
        return c.json({ error: 'System prompt must be 8000 characters or less' }, 400);
      }
      updates.system_prompt = sanitizeForPrompt(body.system_prompt.trim());
    }
    if (body.capabilities !== undefined) updates.capabilities = body.capabilities;
    if (body.max_steps !== undefined) updates.max_steps = body.max_steps;
    if (body.is_shared !== undefined && authUser.role === 'super') {
      updates.is_shared = body.is_shared;
    }
    if (body.avatar !== undefined) {
      updates.avatar = body.avatar;
    }

    const updated = await getDb().customProfiles.update(id, updates);
    if (!updated) return c.json({ error: 'Update failed' }, 500);

    logger.info(`[Profile] ✏️ Custom profile updated: custom:${id} by ${authUser.id}`);
    return c.json(formatCustomProfile(updated));
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
