import { it, expect } from 'vitest';
import { nativeVisible, nativeRoute, pluginHref } from './navigation';
import { nativeScreens } from './native-registry';
import { parseManifest } from './manifest';
it('gates native places on actual nav entries, including renamed plugin owners', () => {
  const page = { id: 'docs', kind: 'native', screen: 'knowledge', title: 'Docs' };
  const state = parseManifest({
    manifest_version: 2,
    core: { version: '4', client_api: 4 },
    plugins: [{ id: 'custom-owner', nav: [{ id: 'docs', page: 'docs', placement: 'primary' }], pages: [page] }],
  });
  expect(nativeVisible(state, 'knowledge')).toBe(true);
  expect(nativeVisible(state, 'tables')).toBe(false);
  expect(nativeVisible({ kind: 'legacy' }, 'tables', false)).toBe(false);
  expect(nativeRoute('future')).toBeUndefined();
  expect(pluginHref('custom-owner', page)).toBe('/knowledge');
});
it('registers all ten known screen ids through their plugin-owned entry', () => {
  expect(Object.keys(nativeScreens).sort()).toEqual(
    ['knowledge', 'tables', 'projects', 'memory', 'feedback', 'computer', 'email', 'skills', 'reports', 'retro'].sort(),
  );
});
