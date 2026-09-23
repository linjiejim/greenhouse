/**
 * Profile routes — /api/profiles
 *
 * GET  /api/profiles                  — 获取所有可用 Profile 列表（系统 + 自定义，含 usage）
 * GET  /api/profiles/custom           — 列出当前用户的自定义 Profile + 他人共享的
 * POST /api/profiles/custom           — 创建自定义 Profile
 * POST /api/profiles/custom/fork      — Fork 一个系统或自定义 Profile
 * GET  /api/profiles/custom/:id       — 获取自定义 Profile 详情
 * GET  /api/profiles/custom/:id/versions — 获取不可变版本历史
 * PUT  /api/profiles/custom/:id       — 追加自定义 Profile 不可变版本（并回到 draft）
 * POST /api/profiles/custom/:id/lifecycle — 提交评审/试点/验证/暂停/退役
 * DELETE /api/profiles/custom/:id     — 归档自定义 Profile（保留版本证据）
 * GET  /api/profiles/:id              — 获取 Profile 详情（含 24h/7d 分时段用量）
 * POST /api/profiles/reload           — 清除缓存并重新加载所有 Profile 配置
 * GET  /api/profiles/usage/summary    — 全局 LLM 用量汇总（按 profile/caller 维度）
 */

import { Hono } from 'hono';
import {
  PRESET_PROFILE_IDS,
  CUSTOM_BASE_PROFILE_IDS,
  DEFAULT_PROFILE_ID,
  clearProfileCache,
  isProfileRunnable,
  isValidCustomBaseProfileId,
  loadAllProfiles,
  loadProfile,
  normalizeProfileId,
  parseCustomProfileReference,
  resolveProfileAsync,
  type AgentProfile,
} from '../profiles/profile.js';
import { getModelEntry, getModelRegistry } from '@greenhouse/agent-core';
import { listChatModels } from '../config/models.js';
import { getDb } from '@greenhouse/db';
import type {
  CustomProfileLifecycleStatus,
  CustomProfileRiskLevel,
  CustomProfileRow,
  CustomProfileVersionRow,
} from '@greenhouse/db';
import { getAuthUser, requireSuper } from '../auth/middleware.js';
import { assertCustomProfileAccess, pinProfileIdForUser, ProfileAccessError } from '../profiles/access.js';
import { getAllToolIds } from '../tools/registry.js';
import { resolveUserTools } from '../agent.js';
import { sanitizeForPrompt } from '../security/security.js';
import { logger } from '@greenhouse/utils/logger';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { AppEnv } from '../app-env.js';
import { withOwnerNicknames } from '../user-display.js';
import type { ProfileAvatar } from '@greenhouse/types/api';

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

/** Get all valid custom base profile IDs. Hidden integration and removed preset profiles are never custom bases. */
function getValidBaseIds(): string[] {
  return [...CUSTOM_BASE_PROFILE_IDS];
}

/** Format a custom profile row for API response. */
function formatCustomProfile(
  row: CustomProfileRow,
  baseProfileMap?: Map<string, AgentProfile>,
  version?: CustomProfileVersionRow,
) {
  const manifest = version ?? row;
  // Rows created before agents owned a model fall back to the catalog default.
  const modelId = manifest.model_id ?? 'flash';
  // A custom agent owns its model, so the displayed provider must come from
  // THAT model's catalog entry — reading it off the base preset made a K3
  // agent forked from Sprouty (quick) report itself as running on DeepSeek.
  // The base is still the fallback for rows created before agents had a model.
  let model: { provider: string; model: string } | undefined;
  const ownProvider = getModelEntry(modelId)?.providers[0]?.provider;
  if (ownProvider) {
    model = { provider: ownProvider, model: modelId };
  } else if (baseProfileMap) {
    const baseId = normalizeProfileId(manifest.base_profile_id) ?? DEFAULT_PROFILE_ID;
    const base = baseProfileMap.get(baseId) ?? baseProfileMap.get(DEFAULT_PROFILE_ID);
    if (base) {
      model = { provider: base.model.provider, model: base.model.model };
    }
  }
  const rawAvatar = safeJsonParse(manifest.avatar, {});
  const avatarRecord =
    rawAvatar && typeof rawAvatar === 'object' && !Array.isArray(rawAvatar)
      ? Object.fromEntries(Object.entries(rawAvatar))
      : {};
  const leafStyle = avatarRecord.leafStyle;
  const eyeStyle = avatarRecord.eyeStyle;
  const avatar: ProfileAvatar = {
    ...(typeof avatarRecord.color === 'string' ? { color: avatarRecord.color } : {}),
    ...(Array.isArray(avatarRecord.accessories)
      ? { accessories: avatarRecord.accessories.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(leafStyle === 'normal' || leafStyle === 'big' || leafStyle === 'mini' || leafStyle === 'double'
      ? { leafStyle }
      : {}),
    ...(eyeStyle === 'classic' || eyeStyle === 'dot' || eyeStyle === 'soft' || eyeStyle === 'focused'
      ? { eyeStyle }
      : {}),
    ...(typeof avatarRecord.faceStyle === 'string' ? { faceStyle: avatarRecord.faceStyle } : {}),
  };
  return {
    id: `custom:${row.id}`,
    slug: row.slug,
    name: manifest.name,
    description: manifest.description,
    base_profile_id: manifest.base_profile_id,
    tools: safeJsonParse(manifest.tools, []) as string[],
    system_prompt: manifest.system_prompt,
    max_steps: manifest.max_steps,
    is_shared: row.is_shared,
    is_custom: true,
    user_id: row.user_id,
    forked_from: row.forked_from || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lifecycle_status: row.lifecycle_status,
    lifecycle_note: row.lifecycle_note,
    current_version: row.current_version,
    published_version: row.published_version,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    next_review_at: row.next_review_at,
    owner_backup_user_id: row.owner_backup_user_id,
    ...(version
      ? {
          manifest_hash: version.manifest_hash,
          change_log: version.change_log,
          purpose: version.purpose,
          audience: version.audience,
          risk_level: version.risk_level,
          budget_policy: safeJsonParse(version.budget_policy, {}) as Record<string, unknown>,
          eval_refs: safeJsonParse(version.eval_refs, []) as unknown[],
        }
      : {}),
    avatar,
    model_id: modelId,
    ...(model ? { model } : {}),
  };
}

async function visibleVersionFor(row: CustomProfileRow, userId: string, isSuper: boolean) {
  const version = isSuper || row.user_id === userId ? row.current_version : row.published_version;
  return version ? getDb().customProfiles.getVersion(row.id, version) : undefined;
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
  // ─── Custom Profile CRUD ─────────────────────────────────

  /** GET /api/profiles/custom — list custom profiles for current user */
  .get('/custom', async (c) => {
    const authUser = getAuthUser(c);

    // Super needs the unshared review queue; ordinary users only receive own
    // assets plus currently published pilot/verified assets.
    const rows =
      authUser.role === 'super'
        ? await getDb().customProfiles.listAll()
        : await getDb().customProfiles.listForUser(authUser.id);
    const baseMap = new Map(loadAllProfiles().map((p) => [p.id, p]));
    const formatted = await Promise.all(
      rows.map(async (r) =>
        formatCustomProfile(r, baseMap, await visibleVersionFor(r, authUser.id, authUser.role === 'super')),
      ),
    );

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

    return c.json({ profiles: await withOwnerNicknames(getDb(), formatted, authUser.id) });
  })
  /** POST /api/profiles/custom — create a custom profile */
  .post('/custom', async (c) => {
    const authUser = getAuthUser(c);

    const body = await c.req.json();
    const {
      name,
      description,
      base_profile_id,
      model_id,
      tools,
      system_prompt,
      max_steps,
      is_shared,
      avatar,
      purpose,
      audience,
      risk_level,
      budget_policy,
      eval_refs,
      owner_backup_user_id,
      review_due_at,
      change_log,
    } = body;

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
    const baseId = normalizeProfileId(base_profile_id) || DEFAULT_PROFILE_ID;
    if (!isValidCustomBaseProfileId(baseId)) {
      return c.json({ error: `Invalid base profile: ${baseId}. Must be one of: ${validBases.join(', ')}` }, 400);
    }

    // An agent pins its own model; it must exist in the deployed catalog.
    const modelId = typeof model_id === 'string' && model_id ? model_id : loadProfile(baseId).model.id;
    if (!modelId || !getModelEntry(modelId)) {
      return c.json(
        { error: `Unknown model: ${model_id}. Available: ${Object.keys(getModelRegistry()).join(', ')}` },
        400,
      );
    }

    // Validate tools are within user's allowed set
    const allTools = getAllToolIds();
    const invalidTools = tools.filter((t: string) => !allTools.includes(t));
    if (invalidTools.length > 0) {
      return c.json({ error: `Unknown tools: ${invalidTools.join(', ')}` }, 400);
    }

    // Check if user has access to the requested tools.
    //
    // This MUST use the same resolver the tool picker is built from
    // (GET /api/tools → resolveUserTools). Recomputing it as
    // `global ∪ assigned` omits the tools a feature flag owns — memory, CRM,
    // Tables, mission_dispatch — so those appeared in the editor and then 403'd
    // on save, for every non-super member. Two spellings of "what may this user
    // use" is one too many.
    if (authUser.role !== 'super') {
      const { allowedTools } = await resolveUserTools(authUser.id, authUser.role);
      const userAllowed = new Set(allowedTools);
      const unauthorized = tools.filter((t: string) => !userAllowed.has(t));
      if (unauthorized.length > 0) {
        return c.json({ error: `You don't have access to these tools: ${unauthorized.join(', ')}` }, 403);
      }
    }

    if (is_shared === true) {
      return c.json({ error: 'Sharing requires lifecycle review; submit the Agent for review after creation' }, 400);
    }
    if (risk_level !== undefined && !['low', 'medium', 'high'].includes(risk_level)) {
      return c.json({ error: 'risk_level must be low, medium, or high' }, 400);
    }

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
        model_id: modelId,
        tools,
        system_prompt: sanitizeForPrompt(system_prompt.trim()),
        max_steps: max_steps || 12,
        is_shared: false,
        avatar: avatar || {},
        purpose: typeof purpose === 'string' ? purpose.trim() || null : null,
        audience: typeof audience === 'string' ? audience.trim() || null : null,
        risk_level: (risk_level as CustomProfileRiskLevel | undefined) ?? 'medium',
        budget_policy:
          budget_policy && typeof budget_policy === 'object' && !Array.isArray(budget_policy) ? budget_policy : {},
        eval_refs: Array.isArray(eval_refs) ? eval_refs : [],
        owner_backup_user_id: typeof owner_backup_user_id === 'string' ? owner_backup_user_id : null,
        review_due_at: typeof review_due_at === 'string' ? review_due_at : null,
        change_log: typeof change_log === 'string' ? change_log : 'Initial version',
        created_by: authUser.id,
      });

      logger.info(`[Profile] ✅ Custom profile created: custom:${row.id} (${row.name}) by ${authUser.id}`);
      const version = await getDb().customProfiles.getCurrentVersion(row.id);
      return c.json(formatCustomProfile(row, undefined, version), 201);
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

    const body = await c.req.json();
    const { source_profile_id, name } = body;

    if (!source_profile_id || typeof source_profile_id !== 'string') {
      return c.json({ error: 'source_profile_id is required' }, 400);
    }

    // Load source profile
    let sourcePrompt: string;
    let sourceTools: string[];
    let sourceMaxSteps: number;
    let sourceName: string;
    let baseProfileId: string;
    let sourceModelId: string | null;
    let sourceReference: string;

    const forkedFromSystemProfile = !source_profile_id.startsWith('custom:');
    if (source_profile_id.startsWith('custom:')) {
      // Fork from another custom profile
      let pinnedSourceReference: string;
      try {
        pinnedSourceReference = await pinProfileIdForUser(authUser, source_profile_id);
      } catch (err) {
        if (err instanceof ProfileAccessError) return c.json({ error: err.message }, err.status);
        throw err;
      }
      const reference = parseCustomProfileReference(pinnedSourceReference);
      if (!reference?.version) return c.json({ error: 'Invalid source custom profile ID' }, 400);
      const sourceRow = await getDb().customProfiles.getById(reference.profileId);
      if (!sourceRow) {
        return c.json({ error: 'Source custom profile not found' }, 404);
      }
      const sourceVersionNumber = reference.version;
      const sourceVersion = await getDb().customProfiles.getVersion(sourceRow.id, sourceVersionNumber);
      if (!sourceVersion) return c.json({ error: 'Source custom profile version not found' }, 409);
      sourceReference = pinnedSourceReference;
      sourcePrompt = sourceVersion.system_prompt;
      sourceTools = safeJsonParse(sourceVersion.tools, []) as string[];
      sourceMaxSteps = sourceVersion.max_steps;
      sourceName = sourceVersion.name;
      baseProfileId = isValidCustomBaseProfileId(normalizeProfileId(sourceVersion.base_profile_id) ?? '')
        ? (normalizeProfileId(sourceVersion.base_profile_id) as string)
        : DEFAULT_PROFILE_ID;
      sourceModelId = sourceVersion.model_id ?? loadProfile(baseProfileId).model.id ?? null;
    } else {
      // Fork from system profile
      const allProfiles = loadAllProfiles();
      const normalizedSourceId = normalizeProfileId(source_profile_id) ?? source_profile_id;
      const source = allProfiles.find((p) => p.id === normalizedSourceId && !p.hidden);
      if (!source) {
        return c.json({ error: `Source system profile not found: ${source_profile_id}` }, 404);
      }
      sourcePrompt = source.system_prompt;
      sourceTools = source.tools;
      sourceMaxSteps = source.max_steps ?? 12;
      sourceName = source.name;
      baseProfileId = isValidCustomBaseProfileId(source.id) ? source.id : DEFAULT_PROFILE_ID;
      // A fork starts on the model it was forked from, then owns it.
      sourceModelId = source.model.id ?? null;
      sourceReference = normalizedSourceId;
    }

    // Filter tools to only those the user has access to.
    //
    // For a system source, `sourceTools` is the profile YAML's `tools:` list —
    // which the runtime never reads (a system profile runs on the user's whole
    // allow-set, see resolveEffectiveTools). Seeding a fork from it produced an
    // Agent strictly weaker than the one it was forked from, with no email,
    // knowledge, attachments or memory, and nothing on screen saying so. A fork
    // of a system Agent therefore starts from what that Agent really runs with:
    // everything this user is allowed.
    const { allowedTools } = await resolveUserTools(authUser.id, authUser.role);
    const userAllowed = new Set(allowedTools);
    const effectiveTools = (forkedFromSystemProfile ? allowedTools : sourceTools).filter((t) => userAllowed.has(t));

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
        model_id: sourceModelId,
        tools: effectiveTools,
        system_prompt: sourcePrompt,
        max_steps: sourceMaxSteps,
        is_shared: false,
        forked_from: sourceReference,
        change_log: `Forked from ${sourceReference}`,
        created_by: authUser.id,
      });

      logger.info(
        `[Profile] \u2699\uFE0F Custom profile forked: custom:${row.id} (${row.name}) from ${source_profile_id} by ${authUser.id}`,
      );
      const baseMap = new Map(loadAllProfiles().map((p) => [p.id, p]));
      const version = await getDb().customProfiles.getCurrentVersion(row.id);
      return c.json(formatCustomProfile(row, baseMap, version), 201);
    } catch (err: any) {
      if (err.message?.includes('uq_custom_profiles_user_slug') || err.code === '23505') {
        return c.json({ error: `A profile with slug "${slug}" already exists. Try a different name.` }, 409);
      }
      throw err;
    }
  })
  /** GET /api/profiles/custom/:id/versions — immutable manifest history */
  .get('/custom/:id/versions', async (c) => {
    const authUser = getAuthUser(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id)) return c.json({ error: 'Invalid profile ID' }, 400);
    const row = await getDb().customProfiles.getById(id);
    if (!row) return c.json({ error: 'Custom profile not found' }, 404);

    const ownsAsset = authUser.role === 'super' || row.user_id === authUser.id;
    if (!ownsAsset) {
      try {
        await assertCustomProfileAccess(authUser, `custom:${id}`);
      } catch (err) {
        if (err instanceof ProfileAccessError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    }
    const versions = await getDb().customProfiles.listVersions(id);
    const visible = ownsAsset ? versions : versions.filter((version) => version.version === row.published_version);
    return c.json({
      profile_id: `custom:${id}`,
      current_version: row.current_version,
      published_version: row.published_version,
      versions: visible.map((version) => ({
        ...version,
        tools: safeJsonParse(version.tools, []) as string[],
        avatar: safeJsonParse(version.avatar, {}) as Record<string, unknown>,
        budget_policy: safeJsonParse(version.budget_policy, {}) as Record<string, unknown>,
        eval_refs: safeJsonParse(version.eval_refs, []) as unknown[],
      })),
    });
  })
  /** POST /api/profiles/custom/:id/lifecycle — governed lifecycle transition */
  .post('/custom/:id/lifecycle', async (c) => {
    const authUser = getAuthUser(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id)) return c.json({ error: 'Invalid profile ID' }, 400);
    const row = await getDb().customProfiles.getById(id);
    if (!row) return c.json({ error: 'Custom profile not found' }, 404);
    if (authUser.role !== 'super' && row.user_id !== authUser.id) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      status?: CustomProfileLifecycleStatus;
      note?: string | null;
      publish_version?: number | null;
      next_review_at?: string | null;
    };
    const statuses: CustomProfileLifecycleStatus[] = [
      'draft',
      'review',
      'pilot',
      'verified',
      'rejected',
      'suspended',
      'deprecated',
      'archived',
    ];
    if (!body.status || !statuses.includes(body.status)) {
      return c.json({ error: 'Invalid lifecycle status' }, 400);
    }
    if (authUser.role !== 'super' && !['draft', 'review', 'archived'].includes(body.status)) {
      return c.json({ error: 'Only super can approve, pilot, verify, reject, suspend, or deprecate Agents' }, 403);
    }

    try {
      const updated = await getDb().customProfiles.transitionLifecycle(id, {
        status: body.status,
        actor_user_id: authUser.id,
        note: typeof body.note === 'string' ? body.note.trim() || null : null,
        publish_version: Number.isInteger(body.publish_version) ? body.publish_version : null,
        next_review_at: typeof body.next_review_at === 'string' ? body.next_review_at : null,
      });
      if (!updated) return c.json({ error: 'Custom profile not found' }, 404);
      const version = await visibleVersionFor(updated, authUser.id, authUser.role === 'super');
      logger.info(
        `[Profile] Lifecycle ${row.lifecycle_status} -> ${updated.lifecycle_status}: custom:${id} by ${authUser.id}`,
      );
      return c.json(formatCustomProfile(updated, undefined, version));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Lifecycle transition failed' }, 409);
    }
  })
  /** GET /api/profiles/custom/:id — get custom profile detail */
  .get('/custom/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid profile ID' }, 400);

    const row = await getDb().customProfiles.getById(id);
    if (!row) return c.json({ error: 'Custom profile not found' }, 404);

    if (row.user_id !== authUser.id && authUser.role !== 'super') {
      try {
        await assertCustomProfileAccess(authUser, `custom:${id}`);
      } catch (err) {
        if (err instanceof ProfileAccessError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    }

    const version = await visibleVersionFor(row, authUser.id, authUser.role === 'super');
    return c.json(formatCustomProfile(row, undefined, version));
  })
  /** PUT /api/profiles/custom/:id — append immutable version and return asset to draft */
  .put('/custom/:id', async (c) => {
    const authUser = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid profile ID' }, 400);

    const row = await getDb().customProfiles.getById(id);
    if (!row) return c.json({ error: 'Custom profile not found' }, 404);

    // Reviewers approve a submitted immutable manifest; only the asset owner
    // may author the next draft version.
    if (row.user_id !== authUser.id) {
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
    if (body.model_id !== undefined) {
      if (typeof body.model_id !== 'string' || !getModelEntry(body.model_id)) {
        return c.json(
          { error: `Unknown model: ${body.model_id}. Available: ${Object.keys(getModelRegistry()).join(', ')}` },
          400,
        );
      }
      updates.model_id = body.model_id;
    }
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) return c.json({ error: 'Tools must be an array' }, 400);
      const allTools = getAllToolIds();
      const invalidTools = body.tools.filter((t: string) => !allTools.includes(t));
      if (invalidTools.length > 0) {
        return c.json({ error: `Unknown tools: ${invalidTools.join(', ')}` }, 400);
      }
      // Validate user has access to these tools — same resolver as the picker
      // and as create; see the note there on why `global ∪ assigned` is wrong.
      if (authUser.role !== 'super') {
        const { allowedTools } = await resolveUserTools(authUser.id, authUser.role);
        const userAllowed = new Set(allowedTools);
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
    if (body.max_steps !== undefined) updates.max_steps = body.max_steps;
    if (body.is_shared === true) {
      return c.json({ error: 'Sharing requires lifecycle review; use the lifecycle endpoint' }, 400);
    }
    if (body.avatar !== undefined) {
      updates.avatar = body.avatar;
    }
    if (body.purpose !== undefined) updates.purpose = body.purpose?.trim() || null;
    if (body.audience !== undefined) updates.audience = body.audience?.trim() || null;
    if (body.risk_level !== undefined) {
      if (!['low', 'medium', 'high'].includes(body.risk_level)) {
        return c.json({ error: 'risk_level must be low, medium, or high' }, 400);
      }
      updates.risk_level = body.risk_level;
    }
    if (body.budget_policy !== undefined) {
      if (!body.budget_policy || typeof body.budget_policy !== 'object' || Array.isArray(body.budget_policy)) {
        return c.json({ error: 'budget_policy must be an object' }, 400);
      }
      updates.budget_policy = body.budget_policy;
    }
    if (body.eval_refs !== undefined) {
      if (!Array.isArray(body.eval_refs)) return c.json({ error: 'eval_refs must be an array' }, 400);
      updates.eval_refs = body.eval_refs;
    }
    if (body.owner_backup_user_id !== undefined) {
      updates.owner_backup_user_id = body.owner_backup_user_id || null;
    }
    if (body.review_due_at !== undefined) updates.review_due_at = body.review_due_at || null;
    updates.change_log = typeof body.change_log === 'string' ? body.change_log.trim() : '';
    updates.created_by = authUser.id;

    const updated = await getDb().customProfiles.update(id, updates);
    if (!updated) return c.json({ error: 'Update failed' }, 500);

    logger.info(
      `[Profile] ✏️ Custom profile version created: custom:${id}@${updated.current_version} by ${authUser.id}`,
    );
    const version = await getDb().customProfiles.getCurrentVersion(id);
    return c.json(formatCustomProfile(updated, undefined, version));
  })
  /** DELETE /api/profiles/custom/:id — archive asset without deleting version evidence */
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

    await getDb().customProfiles.archive(id, authUser.id);
    logger.info(`[Profile] 🗄️ Custom profile archived: custom:${id} (${row.name}) by ${authUser.id}`);
    return c.json({ success: true, status: 'archived' as const });
  })
  // ─── System Profile Routes ───────────────────────────────

  /** GET /api/profiles — list available profiles (system + custom, filtered by user access) */
  .get('/', async (c) => {
    const authUser = getAuthUser(c);
    let all = loadAllProfiles();

    // Hidden system profiles are resolved only by their dedicated server-side
    // integration routes; they never appear in the interactive profile API.
    all = all.filter((p) => !p.hidden && p.access.level !== 'hidden');

    // …and neither does a preset this deployment cannot actually run (its
    // model has no provider key in env) — see isProfileRunnable.
    all = all.filter(isProfileRunnable);

    const usageStats = await getDb().usage.getStatsByProfile();
    const usageMap = new Map(usageStats.map((s) => [s.profile_id, s]));

    // Presets lead, in their declared order (quick → deep → K3 → workflows): the list
    // is what the picker and the Agents page render, so "which agent do I meet
    // first" is a product decision, not an artifact of tool counts or filenames.
    const presetRank = (id: string) => {
      const i = (PRESET_PROFILE_IDS as readonly string[]).indexOf(id);
      return i === -1 ? PRESET_PROFILE_IDS.length : i;
    };
    all.sort((a, b) => presetRank(a.id) - presetRank(b.id) || a.tools.length - b.tools.length);

    const systemProfiles = all.map((p) => {
      const u = usageMap.get(p.id);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        // Per-locale copy rides alongside the flat fields — clients pick, the flat
        // value stays the source language so existing consumers are unaffected.
        name_i18n: p.name_i18n,
        description_i18n: p.description_i18n,
        model: { provider: p.model.provider, model: p.model.model },
        model_id: p.model.id,
        tools: p.tools,
        max_steps: p.max_steps,
        tool_choice: p.tool_choice,
        system_prompt: p.system_prompt,
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
    // The aggregate endpoint feeds the chat picker, not the governance queue:
    // even super only sees own + published assets here. Super's unshared review
    // queue is intentionally confined to GET /custom and the Agents page.
    const customRows = await getDb().customProfiles.listForUser(authUser.id);
    const baseMap = new Map(all.map((p) => [p.id, p]));
    const customProfilesList: Array<
      ReturnType<typeof formatCustomProfile> & { usage: (typeof systemProfiles)[number]['usage'] }
    > = await Promise.all(
      customRows.map(async (r) => {
        const formatted = formatCustomProfile(
          r,
          baseMap,
          await visibleVersionFor(r, authUser.id, authUser.role === 'super'),
        );
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
      }),
    );

    return c.json({
      profiles: [...systemProfiles, ...customProfilesList],
      // The models a user may switch between per turn. Filtered to those with a
      // reachable provider, so a deployment without DEEPSEEK_API_KEY simply never
      // offers `deepseek-flash` (the check `isProfileRunnable` used to do at
      // profile level).
      models: listChatModels(),
    });
  })
  /** GET /api/profiles/:id — get profile detail with time-bucketed usage */
  .use('/:id', requireSuper())
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const normalizedId = normalizeProfileId(id) ?? id;
    try {
      await assertCustomProfileAccess(getAuthUser(c), normalizedId);
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
