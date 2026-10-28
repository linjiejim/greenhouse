import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'memory',
  name: 'Memory',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      {
        id: 'memory',
        label: { en: 'Memory', zh: '记忆' },
        icon: 'Brain',
        page: 'memory',
        placement: 'more',
        order: 10,
      },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'memory',
        kind: 'native',
        screen: 'memory',
        title: { en: 'Memory', zh: '记忆' },
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: ['memory'],
};
