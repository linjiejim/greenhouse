import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'knowledge',
  name: 'Knowledge',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0.0 <5.0.0',
  surfaces: {
    nav: [
      {
        id: 'knowledge',
        label: { en: 'Knowledge', zh: '知识库' },
        icon: 'BookOpen',
        page: 'knowledge',
        placement: 'primary',
        order: 10,
      },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'knowledge',
        kind: 'native',
        screen: 'knowledge',
        title: { en: 'Knowledge', zh: '知识库' },
        fallback_url: '#/knowledge',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: [],
};
