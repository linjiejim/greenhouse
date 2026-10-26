import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'tables',
  name: 'Tables',
  description: 'Internal multidimensional tables, formulas and shared grid views.',
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      {
        id: 'tables',
        label: { en: 'Tables', zh: '表格' },
        icon: 'Table2',
        page: 'tables',
        placement: 'primary',
        order: 30,
      },
    ] satisfies PluginNavItem[],
    pages: [
      { id: 'tables', kind: 'native', screen: 'tables', title: { en: 'Tables', zh: '表格' }, fallback_url: '#/tables' },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  features: ['tables'],
  version: pkg.version,
};
