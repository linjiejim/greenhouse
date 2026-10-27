import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'computer',
  name: 'Computer',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      {
        id: 'computer',
        label: { en: 'Computer', zh: '云电脑' },
        icon: 'Monitor',
        page: 'computer',
        placement: 'more',
        order: 30,
      },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'computer',
        kind: 'native',
        screen: 'computer',
        title: { en: 'Computer', zh: '云电脑' },
        fallback_url: '#/settings/computer',
      },
      {
        // Administration › Cloud computers: the switch and every running computer
        id: 'computer-admin',
        kind: 'native',
        screen: 'computer-admin',
        title: { en: 'Cloud computers', zh: '云电脑管理' },
        parent: 'administration',
        fallback_url: '#/administration/services',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: [],
};
