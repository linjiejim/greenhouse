import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
/** Pure station metadata; the library page is a trusted embed built from ui-src into ui/dist. */
export default {
  id: 'assets',
  name: 'Asset library',
  description: 'Shared images and videos: upload, automatic de-duplication, descriptions, AI tagging and search.',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=4.0.0 <5.0.0',
  surfaces: {
    nav: [
      { id: 'assets', label: { en: 'Assets', zh: '素材库' }, icon: 'Images', page: 'assets', placement: 'more' },
    ] satisfies PluginNavItem[],
    pages: [
      { id: 'assets', kind: 'embed', title: { en: 'Asset library', zh: '素材库' }, url: '/ext/assets/ui/' },
      {
        id: 'assets-settings',
        kind: 'settings-form',
        title: { en: 'Asset library', zh: '素材库' },
        settings: ['assets.ai_enabled', 'assets.ai_language'],
        parent: 'administration',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  ui: './ui',
  features: ['assets', 'assets_manage'],
};
