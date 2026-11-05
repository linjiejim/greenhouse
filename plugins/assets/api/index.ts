import manifest from '../manifest.js';
/**
 * The asset library (素材库): a team's shared images and videos.
 *
 * One row per distinct file (sha256), bytes in the plugin object store, human and AI
 * fields side by side, facets the library managers configure, full-text search, a
 * read-only agent tool, and a trusted embed page that hashes, previews and uploads in
 * the browser. Default off; members get it when the plugin is enabled (feature `assets`),
 * managers through the `assets_manage` feature.
 */
import {
  defineExtension,
  delegatedAgentActor,
  extensionPath,
  getPlatformRuntime,
  requireFeature,
} from '@greenhouse/api/extension-kit';
import { ASSETS_FEATURE, MANAGE_FEATURE } from './access.js';
import { assetsRegistration } from './platform.js';
import { assetRoutes } from './routes.js';
import { assetStore, createServices } from './services.js';
import { ASSET_KIND, assetsQueryTool } from './tool.js';
import { runAiQueue, runCleanup, runVerification } from './worker.js';

export default defineExtension({
  ...manifest,
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createServices,
  resetTables: [
    'ext_assets_similar',
    'ext_assets_collection_items',
    'ext_assets_collections',
    'ext_assets_uploads',
    'ext_assets_facets',
    'ext_assets_assets',
  ],
  ui: { dir: extensionPath(import.meta.url, '../ui') },
  routes: [{ path: '/api/ext/assets', app: assetRoutes, guards: [requireFeature(ASSETS_FEATURE)] }],
  applications: [{ ...assetsRegistration, teamCapabilities: ['assets.*'], platformTools: { query: ['assets_query'] } }],
  tools: [assetsQueryTool],
  mcpGroups: ['assets'],
  featureFlags: [
    {
      key: ASSETS_FEATURE,
      label: 'Asset library',
      description: 'Browse, upload and search the shared images and videos',
      defaultEnabled: true,
    },
    {
      key: MANAGE_FEATURE,
      label: 'Manage the asset library',
      description: 'Edit and delete any asset, merge duplicates, empty the bin and configure facets',
      defaultEnabled: false,
    },
  ],
  featurePoints: [
    {
      key: 'assets',
      title: 'Asset library',
      description: 'Shared images and videos: upload, search and AI tagging.',
      icon: 'Images',
      kind: 'app',
      group: 'apps',
      appId: 'assets',
      flag: ASSETS_FEATURE,
      capabilityPrefix: 'assets.*',
      toolIds: ['assets_query'],
    },
    {
      key: MANAGE_FEATURE,
      title: 'Manage the asset library',
      description: 'Edit and delete any asset, merge duplicates and configure facets.',
      icon: 'Settings',
      kind: 'flag',
      group: 'apps',
      flag: MANAGE_FEATURE,
      toolIds: [],
    },
  ],
  entityKinds: [{ kind: ASSET_KIND, route: '#/ext/assets/asset/:id', page: 'assets' }],
  discriminators: { auditApps: ['assets'] },
  notificationKinds: ['ext:assets:rejected'],
  searchSources: [
    {
      kind: ASSET_KIND,
      search: async ({ db, userId, query, limit }) => {
        if (!(await getPlatformRuntime().authorize(delegatedAgentActor({ userId }), 'assets.library.read')).allowed)
          return [];
        const { items } = await assetStore(db).list({ q: query, limit, sort: 'relevance' });
        return items.map((asset) => ({
          ref: { kind: ASSET_KIND, id: asset.id },
          title: asset.display_title,
          subtitle: asset.description ?? asset.ai_caption ?? asset.original_name,
        }));
      },
    },
  ],
  workspaceSettings: [
    {
      key: 'assets.ai_enabled',
      group: 'assets',
      label: 'AI cataloguing',
      description:
        'Describe and tag new uploads with the vision model (MEDIA_* / VISION_MODEL), charged to the uploader’s budget',
      type: 'boolean',
      defaultValue: true,
    },
    {
      key: 'assets.ai_language',
      group: 'assets',
      label: 'AI language',
      description: 'Language of AI titles, descriptions and tags: zh or en',
      type: 'string',
      maxLength: 2,
      placeholder: 'zh',
    },
  ],
  settingValueValidators: [
    (key, value) =>
      key === 'assets.ai_language' && value !== 'zh' && value !== 'en'
        ? { ok: false, error: 'assets.ai_language must be zh or en' }
        : null,
  ],
  jobs: [
    {
      id: 'assets-worker',
      cron: '* * * * *',
      // The host claims each occurrence (one replica runs it); `protect` skips overlapping runs.
      run: async () => {
        await runVerification();
        await runAiQueue();
      },
    },
    {
      id: 'assets-cleanup',
      cron: '30 3 * * *',
      run: async () => void (await runCleanup()),
    },
  ],
});
