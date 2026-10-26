import type { PluginNavItem, PluginPage } from '@greenhouse/types/plugins';
import pkg from './package.json';
/** Pure station metadata; code belongs in the API and web halves. */
export default {
  id: 'example',
  name: 'Example notes',
  description: 'Reference plugin: per-user notes with a tool, routes, a flag, a setting and a job.',
  version: pkg.version,
  sdk: 2,
  official: true,
  client_min: 4,
  core: '>=3.0 <5',
  surfaces: {
    nav: [
      { id: 'example-embed', label: 'Example UI', icon: 'StickyNote', page: 'example-embed', placement: 'more' },
    ] satisfies PluginNavItem[],
    pages: [
      {
        id: 'example-settings',
        kind: 'settings-form',
        title: 'Example settings',
        settings: ['example.greeting'],
        parent: 'administration',
      },
      {
        id: 'example-embed',
        kind: 'embed',
        title: 'Example UI',
        url: '/ext/example/ui/',
        fallback_url: '#/example/notes',
      },
    ] satisfies PluginPage[],
  },
  dependsOn: [],
  ui: './ui',
  features: ['example'],
};
