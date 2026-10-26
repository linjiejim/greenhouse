import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'feedback',
  name: 'Feedback',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      {
        id: 'feedback',
        label: { en: 'Feedback', zh: '问题与需求' },
        icon: 'MessageSquare',
        page: 'feedback',
        placement: 'more',
        order: 20,
      },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'feedback',
        kind: 'native',
        screen: 'feedback',
        title: { en: 'Feedback', zh: '问题与需求' },
        fallback_url: '#/feedback',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: [],
};
