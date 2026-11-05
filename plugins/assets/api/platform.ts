/**
 * The asset library as a platform application: every HTTP route and tool call is one of
 * these actions, dispatched through the runtime (capability check, then audit). The
 * domain rules (who may edit or delete which asset) are checked inside the operation.
 */
import {
  compileApp,
  defineApp,
  getPlatformRuntime,
  runBoundPlatformOperation,
  type ActorContext,
  type ApplicationRegistration,
  type PlatformActionResult,
  type PlatformHandlerContext,
} from '@greenhouse/api/extension-kit';

export const assetsManifest = compileApp(
  defineApp({
    id: 'assets',
    version: '1.0.0',
    title: 'Asset library',
    description: 'Shared images and videos: upload, de-duplication, descriptions, AI tagging and search.',
    modules: {
      library: { title: 'Library', description: 'Assets, uploads, search and downloads.', icon: 'Images' },
      collections: { title: 'Collections', description: 'Named groups of assets.', icon: 'FolderOpen' },
      admin: { title: 'Library settings', description: 'Facets, duplicates and the bin.', icon: 'Settings' },
    },
    entities: {
      asset: {
        title: 'Asset',
        module: 'library',
        table: 'ext_assets_assets',
        accessScopes: ['all'],
        fields: {
          id: { kind: 'text', title: 'ID', classification: 'internal' },
          kind: { kind: 'enum', title: 'Kind', values: ['image', 'video'], filterable: true },
          displayTitle: { kind: 'text', title: 'Title', searchable: true, sortable: true },
          title: { kind: 'text', title: 'Member title', searchable: true },
          description: { kind: 'longText', title: 'Description', searchable: true },
          tags: { kind: 'json', title: 'Tags', filterable: true },
          facets: { kind: 'json', title: 'Facets', filterable: true },
          source: { kind: 'text', title: 'Source' },
          aiCaption: { kind: 'longText', title: 'AI description', searchable: true },
          aiTags: { kind: 'json', title: 'AI tags' },
          aiText: { kind: 'longText', title: 'Visible text', searchable: true },
          originalName: { kind: 'text', title: 'File name', searchable: true },
          uploadedBy: { kind: 'user', title: 'Uploaded by', filterable: true },
          createdAt: { kind: 'dateTime', title: 'Uploaded at', sortable: true, classification: 'internal' },
        },
      },
      collection: {
        title: 'Collection',
        module: 'collections',
        table: 'ext_assets_collections',
        accessScopes: ['all'],
        fields: {
          id: { kind: 'text', title: 'ID', classification: 'internal' },
          name: { kind: 'text', title: 'Name', required: true, searchable: true },
          description: { kind: 'longText', title: 'Description' },
          createdBy: { kind: 'user', title: 'Created by', classification: 'internal' },
        },
      },
    },
    actions: {
      listAssets: {
        title: 'List assets',
        module: 'library',
        entity: 'asset',
        kind: 'query',
        capability: 'assets.library.read',
        risk: 'read',
        mcp: true,
      },
      readAsset: {
        title: 'Read an asset',
        module: 'library',
        entity: 'asset',
        kind: 'query',
        capability: 'assets.library.read',
        risk: 'read',
        mcp: true,
      },
      searchAssets: {
        title: 'Search assets',
        module: 'library',
        entity: 'asset',
        kind: 'query',
        capability: 'assets.library.read',
        risk: 'read',
        mcp: true,
      },
      downloadAsset: {
        title: 'Download an original',
        module: 'library',
        entity: 'asset',
        kind: 'query',
        capability: 'assets.library.read',
        risk: 'read',
        // Who took which original is worth keeping.
        audit: 'all',
      },
      uploadAsset: {
        title: 'Upload an asset',
        module: 'library',
        entity: 'asset',
        kind: 'command',
        capability: 'assets.library.upload',
        risk: 'low',
      },
      updateAsset: {
        title: 'Edit an asset',
        module: 'library',
        entity: 'asset',
        kind: 'command',
        capability: 'assets.library.edit',
        risk: 'low',
      },
      deleteAsset: {
        title: 'Delete or restore an asset',
        module: 'library',
        entity: 'asset',
        kind: 'command',
        capability: 'assets.library.delete',
        risk: 'destructive',
      },
      manageCollections: {
        title: 'Manage collections',
        module: 'collections',
        entity: 'collection',
        kind: 'command',
        capability: 'assets.collections.manage',
        risk: 'low',
      },
      manageLibrary: {
        title: 'Manage facets and duplicates',
        module: 'admin',
        kind: 'command',
        capability: 'assets.admin.manage',
        risk: 'low',
      },
    },
  }),
);

export type AssetsActionId = keyof typeof assetsManifest.actions;

export const assetsRegistration: ApplicationRegistration<PlatformHandlerContext> = {
  manifest: assetsManifest,
  handlers: Object.fromEntries(Object.keys(assetsManifest.actions).map((id) => [id, runBoundPlatformOperation])),
};

/** Run `operation` as `actionId`: the runtime checks the capability and records the outcome. */
export function dispatchAssets<T>(
  actor: ActorContext,
  actionId: AssetsActionId,
  payload: unknown,
  operation: () => Promise<PlatformActionResult<T>>,
  recordId?: string,
): Promise<PlatformActionResult<T>> {
  const action = assetsManifest.actions[actionId];
  return getPlatformRuntime().dispatch(
    {
      actor,
      appId: assetsManifest.id,
      actionId,
      payload,
      resource: { appId: assetsManifest.id, moduleId: action.module, entityId: action.entity, recordId },
    },
    operation,
  ) as Promise<PlatformActionResult<T>>;
}
