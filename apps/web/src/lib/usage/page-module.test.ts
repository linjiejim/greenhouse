/**
 * The web's page-module mapping and the API's closed list of module ids
 * (`PAGE_MODULE_IDS`) must describe the same modules: a module the web reports
 * but the API rejects is silently never counted, and an id only the API knows
 * is dead weight. This pins both directions against the navigation registry.
 */

import { describe, expect, it } from 'vitest';
import { PAGE_MODULE_IDS, isPageModuleId } from '@greenhouse/types/usage';
import { administrationModules, settingsAllModules } from '../nav-registry';
import { COUNTED_TOP_LEVEL_ROUTES, pageModuleForRoute } from './page-module';

const SIDEBAR_ORGANIZERS = ['session-tags', 'session-groups'];

describe('pageModuleForRoute', () => {
  it('reports every core Settings and Administration module under an id the API accepts', () => {
    for (const mod of [...settingsAllModules, ...administrationModules].filter((m) => !m.extensionId)) {
      const route = mod.parent === 'settings' ? 'settings' : 'administration';
      const key = mod.id.split('.').pop()!;
      const id = pageModuleForRoute({ route, subPath: key });
      expect(id).toBe(mod.id);
      expect(isPageModuleId(id, [])).toBe(true);
    }
  });

  it('reports every counted top-level page under its route name', () => {
    for (const route of COUNTED_TOP_LEVEL_ROUTES) {
      expect(pageModuleForRoute({ route, subPath: 'anything/below' })).toBe(route);
      expect(isPageModuleId(route, [])).toBe(true);
    }
    expect(pageModuleForRoute({ route: 'design', subPath: '' })).toBeNull();
  });

  it('has no API module id the web never reports', () => {
    const reported = new Set<string>([
      ...COUNTED_TOP_LEVEL_ROUTES,
      ...SIDEBAR_ORGANIZERS,
      ...[...settingsAllModules, ...administrationModules].filter((m) => !m.extensionId).map((m) => m.id),
    ]);
    expect([...PAGE_MODULE_IDS].sort()).toEqual([...reported].sort());
  });

  it('falls back to the page default exactly like the pages do', () => {
    expect(pageModuleForRoute({ route: 'settings', subPath: '' })).toBe('settings.preferences');
    expect(pageModuleForRoute({ route: 'settings', subPath: 'no-such-module' })).toBe('settings.preferences');
    expect(pageModuleForRoute({ route: 'administration', subPath: '' })).toBe('admin.users');
    expect(pageModuleForRoute({ route: 'administration', subPath: 'profiles' })).toBe('admin.usage');
    expect(pageModuleForRoute({ route: 'settings', subPath: 'groups/42' })).toBe('settings.groups');
  });

  it('counts an extension page as its extension', () => {
    expect(pageModuleForRoute({ route: 'extension', subPath: 'notes', extensionId: 'example' })).toBe('ext.example');
    expect(pageModuleForRoute({ route: 'extension', subPath: '', extensionId: null })).toBeNull();
    expect(isPageModuleId('ext.example', ['example'])).toBe(true);
  });
});
