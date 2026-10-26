import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
export default {
  id: 'feishu',
  name: 'Feishu',
  description: 'Feishu integration',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: { nav: [] satisfies PluginNavItem[], pages: [] satisfies PluginPage[] },
  dependsOn: [],
  features: [],
};
