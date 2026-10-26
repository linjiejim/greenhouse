import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'projects',
  name: 'Projects',
  description: 'Team projects, tasks and collaboration.',
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      {
        id: 'projects',
        label: { en: 'Projects', zh: '项目' },
        icon: 'FolderKanban',
        page: 'projects',
        placement: 'primary',
        order: 40,
      },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'projects',
        kind: 'native',
        screen: 'projects',
        title: { en: 'Projects', zh: '项目' },
        fallback_url: '#/projects',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: [],
  version: pkg.version,
};
