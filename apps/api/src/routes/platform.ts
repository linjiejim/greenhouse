/**
 * Platform self-service routes — /api/platform
 *
 * GET /api/platform/apps            — 当前用户可见应用、模块、动作与导航
 * GET /api/platform/me/permissions  — 当前用户最终 capability 及判定来源
 * GET /api/platform/me/workbench    — 当前用户工作台偏好
 * PUT /api/platform/me/workbench    — 更新当前用户工作台偏好
 */

import { Hono } from 'hono';
import { isStableId } from '@greenhouse/platform-kernel';
import { getDb } from '@greenhouse/db';
import { parseWorkbenchConfig, type WorkbenchConfig } from '@greenhouse/types/workbench';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { humanActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { userHasFeature } from '../auth/features.js';
import { appFeatureFlag } from '../platform/feature-points.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';

/**
 * Applications this user may see: visible to the actor AND, when the app is
 * owned by a feature flag, that flag enabled.
 *
 * The flag comes from the feature-point registry rather than a list of app ids
 * here, so an application an extension registers is gated identically.
 */
async function visibleApplications(c: Parameters<typeof getAuthUser>[0]) {
  const user = getAuthUser(c);
  const actor = humanActor(user, c);
  const visible = await getPlatformRuntime().listVisibleApplications(actor);
  const allowed = await Promise.all(visible.map((application) => appEnabledFor(user, application.manifest.id)));
  return visible.filter((_, index) => allowed[index]);
}

/** True when the app has no flag, or the user has it. */
async function appEnabledFor(user: ReturnType<typeof getAuthUser>, appId: string): Promise<boolean> {
  const flag = appFeatureFlag(appId);
  return flag ? userHasFeature(user.id, user.role, flag) : true;
}

function stableIdList(value: unknown, field: string, allowedIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${field} must be an array with at most 100 application IDs`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !isStableId(item) || !allowedIds.has(item)) {
      throw new Error(`${field} contains an unavailable application ID`);
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

/**
 * Validate an incoming workbench config.
 *
 * Split of duty (see spec D6): the shared parser in `@greenhouse/types/workbench`
 * owns *shape* — it is the same function the database service and the browser
 * run, so none of the three can drift. This function adds only what needs the
 * request's identity: whether the referenced applications are actually in this
 * user's catalog. Unknown application IDs are rejected rather than dropped, so
 * a client bug surfaces instead of silently losing a preference.
 *
 * Dashboard widgets deliberately get no per-tool check here. Access to a tool
 * is decided every time a card is evaluated (POST /api/workbench/query), which
 * is the only moment that matters; refusing to *save* a card whose tool is
 * currently unavailable would silently delete work the moment a flag flickers.
 */
function validateWorkbenchConfig(value: unknown, allowedIds: ReadonlySet<string>): WorkbenchConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workbench preferences must be an object');
  }
  const body = value as Record<string, unknown>;
  const appOrder = stableIdList(body.appOrder ?? [], 'appOrder', allowedIds);
  const pinnedAppIds = stableIdList(body.pinnedAppIds ?? [], 'pinnedAppIds', allowedIds);
  const hiddenAppIds = stableIdList(body.hiddenAppIds ?? [], 'hiddenAppIds', allowedIds);
  if (pinnedAppIds.some((appId) => hiddenAppIds.includes(appId))) {
    throw new Error('An application cannot be both pinned and hidden');
  }
  const defaultAppId =
    body.defaultAppId === null || body.defaultAppId === undefined
      ? null
      : typeof body.defaultAppId === 'string' && isStableId(body.defaultAppId) && allowedIds.has(body.defaultAppId)
        ? body.defaultAppId
        : undefined;
  if (defaultAppId === undefined) {
    throw new Error('defaultAppId must be an available application ID or null');
  }
  if (defaultAppId && hiddenAppIds.includes(defaultAppId)) {
    throw new Error('The default application cannot be hidden');
  }
  if (body.density !== undefined && body.density !== 'comfortable' && body.density !== 'compact') {
    throw new Error('density must be comfortable or compact');
  }
  return parseWorkbenchConfig({
    ...body,
    appOrder,
    pinnedAppIds,
    hiddenAppIds,
    defaultAppId,
  });
}

/** Drop application IDs the user can no longer see, without touching widgets. */
function filterConfigToCatalog(stored: WorkbenchConfig, allowedIds: ReadonlySet<string>): WorkbenchConfig {
  const hiddenAppIds = stored.hiddenAppIds.filter((appId) => allowedIds.has(appId));
  return {
    ...stored,
    appOrder: stored.appOrder.filter((appId) => allowedIds.has(appId)),
    pinnedAppIds: stored.pinnedAppIds.filter((appId) => allowedIds.has(appId) && !hiddenAppIds.includes(appId)),
    hiddenAppIds,
    defaultAppId:
      stored.defaultAppId && allowedIds.has(stored.defaultAppId) && !hiddenAppIds.includes(stored.defaultAppId)
        ? stored.defaultAppId
        : null,
  };
}

class WorkbenchConflictError extends Error {}

const platformRoutes = new Hono<AppEnv>()
  .get('/apps', async (c) => {
    const applications = await visibleApplications(c);
    return c.json({
      applications: applications.map(({ manifest, allowedActionIds, allowedCapabilities }) => {
        const allowedActions = Object.values(manifest.actions).filter((action) => allowedActionIds.includes(action.id));
        const visibleModuleIds = new Set(allowedActions.map((action) => action.module));
        return {
          id: manifest.id,
          version: manifest.version,
          title: manifest.title,
          description: manifest.description,
          modules: Object.fromEntries(
            Object.entries(manifest.modules).filter(([moduleId]) => visibleModuleIds.has(moduleId)),
          ),
          actions: Object.fromEntries(allowedActions.map((action) => [action.id, action])),
          navigation: manifest.navigation.filter(
            (item) =>
              visibleModuleIds.has(item.module) && (!item.capability || allowedCapabilities.includes(item.capability)),
          ),
          capabilities: allowedCapabilities,
        };
      }),
    });
  })
  .get('/me/workbench', async (c) => {
    const user = getAuthUser(c);
    const applications = await visibleApplications(c);
    const allowedIds = new Set(applications.map((application) => application.manifest.id));
    const stored = await getDb().platform.getUserWorkbenchPreferences(PLATFORM_ORG_ID, user.id);
    return c.json({ preferences: filterConfigToCatalog(stored, allowedIds) });
  })
  .put('/me/workbench', async (c) => {
    const user = getAuthUser(c);
    const applications = await visibleApplications(c);
    const allowedIds = new Set(applications.map((application) => application.manifest.id));
    try {
      const raw = await c.req.json().catch(() => undefined);
      const envelope =
        raw && typeof raw === 'object' && !Array.isArray(raw) && 'preferences' in raw
          ? (raw as { preferences: unknown; base?: unknown })
          : null;
      const preferences = validateWorkbenchConfig(envelope?.preferences ?? raw, allowedIds);
      const base = envelope?.base === undefined ? null : validateWorkbenchConfig(envelope.base, allowedIds);
      const saved = await getDb().platform.mutateUserWorkbenchPreferences(PLATFORM_ORG_ID, user.id, (current) => {
        if (base && JSON.stringify(filterConfigToCatalog(current, allowedIds)) !== JSON.stringify(base)) {
          throw new WorkbenchConflictError('Workbench changed in another tab or conversation');
        }
        return preferences;
      });
      return c.json({ preferences: filterConfigToCatalog(saved, allowedIds) });
    } catch (error) {
      if (error instanceof WorkbenchConflictError) {
        return c.json({ error: error.message }, 409);
      }
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Invalid workbench preferences',
        },
        400,
      );
    }
  })
  .get('/me/permissions', async (c) => {
    const user = getAuthUser(c);
    const actor = humanActor(user, c);
    const runtime = getPlatformRuntime();
    const manifests = runtime.listManifests();
    const enabled = new Map(
      await Promise.all(
        manifests.map(async (manifest) => [manifest.id, await appEnabledFor(user, manifest.id)] as const),
      ),
    );
    const permissions = [];
    for (const manifest of manifests) {
      for (const capability of manifest.capabilities) {
        if (!enabled.get(manifest.id)) {
          permissions.push({
            appId: manifest.id,
            capability,
            allowed: false,
            reason: 'feature-disabled',
          });
          continue;
        }
        const decision = await runtime.authorize(actor, capability);
        permissions.push({
          appId: manifest.id,
          capability,
          allowed: decision.allowed,
          reason: decision.reason,
          matchedPattern: decision.matchedPattern,
          sourceId: decision.sourceId,
        });
      }
    }
    return c.json({ permissions });
  });

export default platformRoutes;
