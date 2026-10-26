import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'reports',
  name: 'Reports',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      {
        id: 'reports',
        label: { en: 'Reports', zh: '报告' },
        icon: 'FileText',
        page: 'reports',
        placement: 'more',
        order: 60,
      },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'reports',
        kind: 'native',
        screen: 'reports',
        title: { en: 'Reports', zh: '报告' },
        fallback_url: '#/skillhub?tab=reports',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: [],
};
