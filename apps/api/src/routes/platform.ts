/**
 * Platform self-service routes — /api/platform
 *
 * GET /api/platform/apps            — 当前用户可见应用、模块、动作与导航
 * GET /api/platform/me/permissions  — 当前用户最终 capability 及判定来源
 */

import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { humanActor } from '../plugin-host/actor.js';
import { getPlatformRuntime } from '../plugin-host/runtime.js';
import { userHasFeature } from '../auth/features.js';
import { appFeatureFlag } from '../plugin-host/feature-points.js';

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
