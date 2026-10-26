import { expect, vi } from 'vitest';
import { Hono } from 'hono';
/** Re-import registrations under an empty deployment, like a real process restart. */
export async function assertPluginDisabled(id: string, routes: string[], toolIds: string[]) {
  vi.resetModules();
  vi.stubEnv('GREENHOUSE_EXTENSIONS', '');
  try {
    const extensions = await import('../index.js');
    const boot = await import('../boot.js');
    const tools = await import('../../tools/registry.js');
    const features = await import('@greenhouse/types/features');
    const settings = await import('@greenhouse/types/workspace-settings');
    const groups = await import('@greenhouse/types/mcp');
    const prices = await import('../../config/services.js');
    expect(extensions.EXTENSIONS.some((ext) => ext.id === id)).toBe(false);
    for (const toolId of toolIds) {
      expect(tools.getAllToolIds()).not.toContain(toolId);
      expect(tools.BUILTIN_AGENT_TOOL_IDS.has(toolId)).toBe(false);
    }
    expect(features.allFeatureFlags().some((flag) => flag.key === id)).toBe(false);
    expect(settings.allWorkspaceSettings().some((setting) => setting.group === id)).toBe(false);
    expect(groups.allMcpResourceGroups()).not.toContain(id);
    expect(prices.getServiceCatalog()).not.toHaveProperty(id);
    for (const field of [
      'teamContextSources',
      'mcpResources',
      'toolResults',
      'workspaceTimeZoneChanged',
      'schedules',
      'settingValueValidators',
    ] as const)
      expect(extensions.fromExtensions(field)).toEqual([]);
    expect(extensions.fromExtensions('jobs')).toEqual([]);
    expect(extensions.fromExtensions('automationTools')).toEqual([]);
    expect(extensions.fromExtensions('retiredToolAliases')).toEqual([]);
    expect(extensions.fromExtensions('hubContext')).toEqual([]);
    expect(extensions.fromExtensions('seeds')).toEqual([]);
    expect(extensions.fromExtensions('channels')).toEqual([]);
    expect(extensions.fromExtensions('retention')).toEqual([]);
    expect(extensions.fromExtensions('agentContext')).toEqual([]);
    expect(extensions.fromExtensions('catalogSources')).toEqual([]);
    expect(extensions.fromExtensions('discriminators')).toEqual([]);
    const drive = await import('../../drive/access.js');
    expect(drive.isKnownDriveScope(id)).toBe(false);
    if (id === 'knowledge') expect(drive.isKnownDriveScope('kb')).toBe(false);
    expect(extensions.fromExtensions('recentChanges')).toEqual([]);
    expect(extensions.fromExtensions('objectRefs')).toEqual([]);
    expect(extensions.fromExtensions('searchSources')).toEqual([]);
    expect(extensions.fromExtensions('rateLimits')).toEqual([]);
    expect(extensions.fromExtensions('entityKinds')).toEqual([]);
    const transports = await import('../../notifications/transports.js');
    const providers = await import('../../auth/identity-providers.js');
    expect(transports.notificationTransports()).toEqual([]);
    expect(providers.identityProviders()).toEqual([]);
    const publicPaths = await import('../../auth/middleware.js');
    for (const route of routes) expect(publicPaths.isPublicPath(route)).toBe(false);
    const discovery = new Hono().route('/api/auth', providers.identityDiscoveryRoutes);
    expect(await (await discovery.request('/api/auth/providers')).json()).toEqual({ providers: [] });
    const app = new Hono();
    boot.mountExtensionRoutes(app as never);
    for (const route of routes) expect((await app.request(route)).status).toBe(404);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}
