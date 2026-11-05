/**
 * `assets_query` — the asset library for agents (chat, the Agent API and MCP): search,
 * list, read one asset, list collections. Read-only: uploads happen in the library page,
 * where the browser hashes and previews files.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { entityUrl } from '@greenhouse/types/entity-links';
import {
  CITE_URL_INSTRUCTION,
  defineTool,
  delegatedAgentActor,
  toErrorMessage,
  type PlatformActionResult,
  type ToolMeta,
} from '@greenhouse/api/extension-kit';
import { dispatchAssets, type AssetsActionId } from './platform.js';
import type { AssetRow, FacetRow } from './schema.js';
import { assetStore } from './services.js';

export const ASSET_KIND = 'ext:assets:asset';

const schema = z.object({
  action: z
    .enum(['search', 'list', 'get', 'collections'])
    .describe(
      '"search": keyword search over titles, descriptions, tags, facet values and visible text. "list": newest first, with filters. "get": one asset by id. "collections": the named collections.',
    ),
  query: z.string().max(200).optional().describe('Keywords for search, in the language the library is described in.'),
  id: z.string().max(64).optional().describe('Asset id for get, exactly as a result returned it.'),
  kind: z.enum(['image', 'video']).optional(),
  facets: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe('Facet filters: {"<facet key>": ["<value>", …]}; facet keys and values are listed by "collections".'),
  collection_id: z.string().max(64).optional().describe('Only assets in this collection.'),
  limit: z.number().int().min(1).max(30).optional().describe('Max results (default 10).'),
  offset: z.number().int().min(0).optional(),
});
type Input = z.infer<typeof schema>;

const meta: ToolMeta = {
  id: 'assets_query',
  name: 'Asset library',
  brief: 'Find shared images and videos in the asset library',
  description: `Read-only access to the team's asset library (shared images and videos). Actions: search, list, get, collections.
Results carry a title (the member's, else an AI suggestion marked title_from "ai"), the AI description, tags, facet values, size, dimensions, duration and who uploaded it. Assets are files: you cannot see the pictures themselves; describe them from these fields and give the link so the person can open them. Use "collections" first to learn the facet vocabulary and collection names.

${CITE_URL_INSTRUCTION}`,
  category: 'team',
  is_global: false,
  surface: { proxy: 'read', mcp: 'assets', unattendedReplaySafe: true },
  icon: 'Images',
  sort_order: 40,
};

function facetLabels(values: Record<string, string[]>, defs: readonly FacetRow[]) {
  return Object.fromEntries(
    defs
      .filter((def) => values[def.key]?.length)
      .map((def) => [def.key, values[def.key]!.map((v) => def.values.find((x) => x.value === v)?.zh ?? v)]),
  );
}

function summary(asset: AssetRow, defs: readonly FacetRow[]) {
  return {
    id: asset.id,
    url: entityUrl({ kind: ASSET_KIND, id: asset.id }),
    kind: asset.kind,
    title: asset.display_title,
    title_from: asset.title ? 'member' : asset.ai_title ? 'ai' : 'file',
    description: asset.description ?? asset.ai_caption ?? undefined,
    tags: [...new Set([...asset.tags, ...asset.ai_tags])],
    facets: facetLabels(asset.facets, defs),
    ...(Object.keys(asset.ai_facets).length ? { ai_facets: facetLabels(asset.ai_facets, defs) } : {}),
    file: asset.original_name,
    size_bytes: asset.size,
    ...(asset.width ? { width: asset.width, height: asset.height } : {}),
    ...(asset.duration_ms ? { duration_s: Math.round(asset.duration_ms / 100) / 10 } : {}),
    uploaded_by: asset.uploaded_by,
    uploaded_at: asset.created_at,
  };
}

export function createAssetsQueryTool(ctx: { userId: string }) {
  return tool({
    description: meta.description,
    inputSchema: schema,
    execute: async (input: Input) => {
      const actionId: AssetsActionId =
        input.action === 'get' ? 'readAsset' : input.action === 'search' ? 'searchAssets' : 'listAssets';
      const result = await dispatchAssets(
        delegatedAgentActor({ userId: ctx.userId }),
        actionId,
        input,
        async (): Promise<PlatformActionResult<unknown>> => {
          try {
            const store = assetStore();
            const defs = await store.facetDefs();
            if (input.action === 'collections') {
              return {
                ok: true,
                data: {
                  collections: (await store.listCollections()).map((c) => ({
                    id: c.id,
                    name: c.name,
                    assets: c.count,
                  })),
                  facets: defs.map((d) => ({
                    key: d.key,
                    label: d.label_zh || d.label_en,
                    multiple: d.multiple,
                    values: d.values.map((v) => (v.zh ? `${v.value} (${v.zh})` : v.value)),
                  })),
                },
              };
            }
            if (input.action === 'get') {
              if (!input.id) return { ok: false, code: 'INVALID_INPUT', message: 'get needs id' };
              const asset = await store.get(input.id);
              if (!asset || asset.status !== 'active')
                return { ok: false, code: 'NOT_FOUND', message: 'No such asset' };
              return {
                ok: true,
                data: {
                  asset: {
                    ...summary(asset, defs),
                    ...(asset.ai_text ? { visible_text: asset.ai_text } : {}),
                    ...(asset.source ? { source: asset.source } : {}),
                    collections: (await store.collectionsFor(asset.id)).map((c) => c.name),
                  },
                },
              };
            }
            if (input.action === 'search' && !input.query?.trim())
              return { ok: false, code: 'INVALID_INPUT', message: 'search needs query' };
            const { items, total } = await store.list({
              q: input.action === 'search' ? input.query : undefined,
              kind: input.kind,
              facets: input.facets,
              collectionId: input.collection_id,
              sort: input.action === 'search' ? 'relevance' : 'new',
              limit: input.limit ?? 10,
              offset: input.offset ?? 0,
            });
            return { ok: true, data: { total, found: items.length, results: items.map((a) => summary(a, defs)) } };
          } catch (err) {
            return { ok: false, code: 'INTERNAL_ERROR', message: toErrorMessage(err) };
          }
        },
        input.id,
      );
      return result.ok ? result.data : { error: result.message };
    },
  });
}

export const assetsQueryTool = defineTool({
  meta,
  kind: 'lazy',
  createLazy: ({ userId }) => createAssetsQueryTool({ userId }),
});
