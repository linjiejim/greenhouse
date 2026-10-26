import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'email',
  name: 'Email',
  description: 'Email integration',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      { id: 'email', label: { en: 'Email', zh: '邮件' }, icon: 'Mail', page: 'email', placement: 'more', order: 40 },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'email',
        kind: 'native',
        screen: 'email',
        title: { en: 'Email', zh: '邮件' },
        fallback_url: '#/settings/email',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: ['email'],
};
