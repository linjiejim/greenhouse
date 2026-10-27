import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'retro',
  name: 'Monthly retro',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0.0 <5.0.0',
  surfaces: {
    // An Admin section, not an app: no nav entry.
    nav: [] satisfies PluginNavItem[],
    pages: [
      {
        id: 'retro',
        kind: 'native',
        screen: 'retro',
        title: { en: 'Monthly retro', zh: '每月复盘' },
        parent: 'administration',
        fallback_url: '#/administration/retro',
        requireRole: 'super',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: ['knowledge'],
  features: [],
};
