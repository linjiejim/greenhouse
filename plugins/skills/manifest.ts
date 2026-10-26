import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'skills',
  name: 'SkillHub',
  description: 'Shared agent skills, versions and security scanning.',
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      {
        id: 'skills',
        label: { en: 'Skills', zh: '技能' },
        icon: 'Sparkles',
        page: 'skills',
        placement: 'more',
        order: 50,
      },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'skills',
        kind: 'native',
        screen: 'skills',
        title: { en: 'Skills', zh: '技能' },
        fallback_url: '#/skillhub',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: [],
  version: pkg.version,
};
