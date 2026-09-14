/**
 * The extension seam, end to end at the registry level: with the example
 * extension switched on, every core registry sees its contribution; switched
 * off, none does. Modules are re-imported per case because the registries are
 * computed at load time from `GREENHOUSE_EXTENSIONS`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

async function loadWith(enabled: string) {
  vi.resetModules();
  vi.stubEnv('GREENHOUSE_EXTENSIONS', enabled);
  // Sequential on purpose: the registry graph has import cycles, and loading
  // it concurrently after resetModules() can deadlock the module runner.
  const extensions = await import('../index.js');
  const boot = await import('../boot.js');
  const registry = await import('../../tools/registry.js');
  const points = await import('../../platform/feature-points.js');
  const features = await import('@greenhouse/types/features');
  const settings = await import('@greenhouse/types/workspace-settings');
  const middleware = await import('../../auth/middleware.js');
  const entityLinks = await import('@greenhouse/types/entity-links');
  const mcp = await import('@greenhouse/types/mcp');
  const workbench = await import('@greenhouse/types/workbench');
  const searchSources = await import('../../search/sources.js');
  const oauth = await import('../../platform/oauth.js');
  return {
    extensions,
    boot,
    registry,
    points,
    features,
    settings,
    middleware,
    entityLinks,
    mcp,
    workbench,
    searchSources,
    oauth,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('extension seam', { timeout: 60_000 }, () => {
  it('folds an enabled extension into every registry', async () => {
    const m = await loadWith('example');
    expect(m.extensions.EXTENSIONS.map((e) => e.id)).toEqual(['example']);

    // tools: catalog + derived proxy surface + feature ownership
    expect(m.registry.getAllToolIds()).toContain('example_notes_query');
    expect(m.registry.READONLY_PROXY_ALLOWLIST).toContain('example_notes_query');
    expect(m.registry.WORKBENCH_READ_TOOL_IDS).toContain('example_notes_query');
    expect(m.registry.LAZY_TOOL_IDS).toContain('example_notes_query');
    expect(m.points.FEATURE_POINTS.find((p) => p.key === 'example')?.toolIds).toEqual(['example_notes_query']);
    expect(m.points.FEATURE_OWNED_TOOL_IDS.has('example_notes_query')).toBe(true);
    expect(m.points.toolsetToolIds()).not.toContain('example_notes_query');

    // flags + settings registered into the shared packages
    expect(m.features.allFeatureFlags().map((f) => f.key)).toContain('example');
    expect(m.features.featureDefault('example')).toBe(false);
    expect(m.settings.allWorkspaceSettings().map((s) => s.key)).toContain('example.greeting');
    expect(m.settings.getWorkspaceSettingDef('example.greeting')?.group).toBe('example');

    // boot glue: routes, jobs, commands, migrations
    expect(m.boot.extensionCommands().map((c) => c.name)).toEqual(['example:count']);
    expect(m.boot.extensionJobs().map((j) => j.id)).toEqual(['example-note-count']);
    const sources = m.boot.extensionMigrationSources();
    expect(sources).toHaveLength(1);
    expect(existsSync(sources[0].dir)).toBe(true);
    expect(m.boot.extensionApplicationRegistrations()).toEqual([]);

    // no public paths were declared, so auth still guards the extension routes
    expect(m.middleware.isPublicPath('/api/ext/example/notes')).toBe(false);
  });

  it('opens the four shared registries to the extension', async () => {
    const m = await loadWith('example');

    // entity kinds: deeplinks in tool output, peeks in chat
    expect(m.entityLinks.extensionEntityKinds().map((d) => d.kind)).toContain('ext:example:note');
    const ref = { kind: 'ext:example:note', id: 42 } as const;
    expect(m.entityLinks.entityUrl(ref)).toBe('#/example/notes/42');
    expect(m.entityLinks.parseEntityUrl('#/example/notes/42')).toEqual(ref);
    // a list page is not a record
    expect(m.entityLinks.parseEntityUrl('#/example/notes')).toBeNull();

    // MCP consent group → an OAuth scope of its own
    expect(m.mcp.allMcpResourceGroups()).toContain('example');
    expect(m.oauth.oauthSupportedScopes()).toContain('mcp:example');
    expect(m.oauth.normalizeOAuthScopes('mcp:read mcp:example')).toEqual(['mcp:read', 'mcp:example']);
    expect(m.oauth.resourceGroupsFromScopes(['mcp:read', 'mcp:example'])).toEqual(['example']);
    expect(m.registry.MCP_EXPOSED_TOOL_IDS).toContain('example_notes_query');

    // search lane + workbench recipe
    expect(m.searchSources.extensionSearchSources().map((s) => s.kind)).toEqual(['ext:example:note']);
    expect(m.workbench.allWidgetRecipes().map((r) => r.id)).toContain('example.notes');
    expect(m.workbench.availableRecipes(['example_notes_query']).map((r) => r.id)).toEqual(['example.notes']);
  });

  it('contributes nothing while disabled', async () => {
    const m = await loadWith('');
    expect(m.extensions.EXTENSIONS).toEqual([]);
    expect(m.extensions.COMPILED_EXTENSIONS.map((e) => e.id)).toEqual(['example']);
    expect(m.registry.getAllToolIds()).not.toContain('example_notes_query');
    expect(m.points.FEATURE_POINTS.some((p) => p.key === 'example')).toBe(false);
    expect(m.features.allFeatureFlags().some((f) => f.key === 'example')).toBe(false);
    expect(m.settings.allWorkspaceSettings().some((s) => s.key === 'example.greeting')).toBe(false);
    expect(m.boot.extensionCommands()).toEqual([]);
    expect(m.boot.extensionMigrationSources()).toEqual([]);
    expect(m.entityLinks.extensionEntityKinds()).toEqual([]);
    expect(m.mcp.allMcpResourceGroups()).not.toContain('example');
    expect(m.oauth.oauthSupportedScopes()).not.toContain('mcp:example');
    expect(m.searchSources.extensionSearchSources()).toEqual([]);
    expect(m.workbench.allWidgetRecipes().some((r) => r.id === 'example.notes')).toBe(false);
    expect(() => m.entityLinks.entityUrl({ kind: 'ext:example:note', id: 1 })).toThrow(/Unknown entity kind/);
  });

  it('keeps the feature-point invariants with the extension on', async () => {
    const m = await loadWith('example');
    // every flag has a point and vice versa — the same rule the core parity test enforces
    const flagKeys = new Set(m.features.allFeatureFlags().map((f) => f.key));
    for (const point of m.points.FEATURE_POINTS) {
      if (point.kind === 'flag') expect(flagKeys.has(point.flag ?? '')).toBe(true);
    }
    for (const key of flagKeys) expect(m.points.FEATURE_POINTS.some((p) => p.flag === key)).toBe(true);
  });

  it('rejects duplicate ids and malformed ids early', async () => {
    const { defineExtension } = await import('../define.js');
    expect(() => defineExtension({ id: 'Bad Id', name: 'x' })).toThrow(/must match/);
    expect(defineExtension({ id: 'fine-1', name: 'x' }).id).toBe('fine-1');
  });
});
