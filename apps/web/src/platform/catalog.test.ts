import { describe, expect, it } from 'vitest';
import { normalizeWorkbenchPreferences, platformApplicationHref, type PlatformApplication } from './catalog.js';

function application(id: string, path = `/${id}`): PlatformApplication {
  return {
    id,
    version: '1.0.0',
    title: id,
    modules: {},
    actions: {},
    navigation: [{ id, title: id, module: 'main', path }],
    capabilities: [],
  };
}

describe('Platform web catalog', () => {
  // Application *visibility* is filtered server-side on read (see the workbench
  // route tests); the browser normalizer is deliberately shape-only, so it must
  // not be asserted to drop unknown IDs here.
  it('normalizes shape and migrates a v1 blob without losing app preferences', () => {
    expect(
      normalizeWorkbenchPreferences({
        version: 1,
        appOrder: ['knowledge', 'knowledge', 'projects'],
        pinnedAppIds: ['knowledge', 'projects'],
        hiddenAppIds: ['projects'],
        defaultAppId: 'projects',
        density: 'compact',
      }),
    ).toEqual({
      version: 2,
      appOrder: ['knowledge', 'projects'],
      // Hidden wins over pinned, and a hidden app cannot be the landing default.
      pinnedAppIds: ['knowledge'],
      hiddenAppIds: ['projects'],
      defaultAppId: null,
      density: 'compact',
      tabs: [],
      widgets: [],
    });
  });

  it('only links applications with an explicitly registered host UI', () => {
    expect(platformApplicationHref(application('projects'))).toBe('#/projects');
    expect(platformApplicationHref(application('tables'))).toBe('#/tables');
    expect(platformApplicationHref(application('pulse'))).toBeNull();
    expect(platformApplicationHref(application('analytics', 'https://example.test'))).toBeNull();
  });
});
