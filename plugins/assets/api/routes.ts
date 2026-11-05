/**
 * /api/ext/assets — the asset library's HTTP surface (mounted behind `requireFeature('assets')`).
 *
 * Upload (one file):
 *   POST /uploads/check            {items:[{sha256,size}]}       → which contents already exist
 *   POST /uploads                  file facts + member fields    → duplicate, or upload targets
 *   (browser PUTs original, thumb, preview, frames to the targets)
 *   POST /assets/:id/complete                                    → size-checked, active, queued for AI
 * Library:
 *   GET  /config  GET /stats  GET /assets  GET /assets/:id  PATCH /assets/:id  POST /assets/batch
 *   DELETE /assets/:id  POST /assets/:id/restore  GET /assets/:id/download
 *   POST /assets/:id/ai/retry  POST /assets/:id/ai/accept
 * Collections:  GET/POST /collections  PATCH/DELETE /collections/:id  POST/DELETE /collections/:id/items
 * Managers:     GET/PUT /facets  GET /duplicates  POST /duplicates/merge  POST /duplicates/dismiss
 *
 * Every route runs as one platform action (capability + audit, `platform.ts`); who may touch
 * which asset is decided in `access.ts`. Media URLs are short-lived (`pluginObjects().readUrl`).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { humanActor, type AppEnv, type PlatformActionResult } from '@greenhouse/api/extension-kit';
import { aiEnabled, objects } from './ai.js';
import { canEdit, canManage, type Member } from './access.js';
import {
  cleanFilename,
  DERIVED_TYPE,
  IMAGE_TYPES,
  kindForType,
  MAX_CHECK_ITEMS,
  MAX_FRAME_BYTES,
  MAX_FRAMES,
  MAX_IMAGE_BYTES,
  MAX_PREVIEW_BYTES,
  MAX_THUMB_BYTES,
  MAX_VIDEO_BYTES,
  maxBytesFor,
  objectKeys,
  PHASH,
  SHA256,
  VIDEO_TYPES,
} from './model.js';
import { dispatchAssets, type AssetsActionId } from './platform.js';
import type { AssetRow, FacetValues } from './schema.js';
import { assetStore } from './services.js';
import type { AssetListQuery } from './store.js';

const INLINE_ORIGINALS = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  ...Object.keys(VIDEO_TYPES),
]);

const Text = (max: number) => z.string().max(max);
const FacetsInput = z.record(z.string().max(64), z.array(z.string().max(120)).max(50));
const HumanInput = z.object({
  title: Text(200).nullish(),
  description: Text(4000).nullish(),
  source: Text(500).nullish(),
  tags: z.array(Text(40)).max(30).optional(),
  facets: FacetsInput.optional(),
});
const UploadInput = HumanInput.extend({
  sha256: z.string().regex(SHA256),
  size: z.number().int().min(1).max(MAX_VIDEO_BYTES),
  filename: z.string().min(1).max(1000),
  content_type: z.string().max(100),
  width: z.number().int().min(1).max(100_000).nullish(),
  height: z.number().int().min(1).max(100_000).nullish(),
  duration_ms: z
    .number()
    .int()
    .min(0)
    .max(24 * 3_600_000)
    .nullish(),
  phash: z.string().regex(PHASH).nullish(),
  has_preview: z.boolean(),
  frame_count: z.number().int().min(0).max(MAX_FRAMES),
  collection_id: z.string().max(64).nullish(),
});
const Ids = z.array(z.string().max(64)).min(1).max(500);

function member(c: Context<AppEnv>): Member {
  const user = c.get('user');
  return { id: user.id, role: user.role };
}

const STATUS = { INVALID_INPUT: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL_ERROR: 500 } as const;
const fail = (code: keyof typeof STATUS, message: string) => ({ ok: false as const, code, message });
const ok = <T>(data: T) => ({ ok: true as const, data });

async function run(
  c: Context<AppEnv>,
  actionId: AssetsActionId,
  operation: () => Promise<PlatformActionResult<unknown>>,
  recordId?: string,
) {
  const result = await dispatchAssets(
    humanActor(c.get('user'), c),
    actionId,
    { transport: 'http' },
    operation,
    recordId,
  );
  return result.ok ? c.json(result.data as object) : c.json({ error: result.message }, STATUS[result.code]);
}

async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** A list entry: enough to draw a tile. */
export async function card(asset: AssetRow) {
  return {
    id: asset.id,
    kind: asset.kind,
    status: asset.status,
    title: asset.display_title,
    title_from: asset.title ? 'member' : asset.ai_title ? 'ai' : 'file',
    content_type: asset.content_type,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    duration_ms: asset.duration_ms,
    has_preview: asset.has_preview,
    ai_status: asset.ai_status,
    uploaded_by: asset.uploaded_by,
    created_at: asset.created_at,
    deleted_at: asset.deleted_at,
    thumb_url: asset.has_preview
      ? await objects.readUrl(objectKeys.thumb(asset.sha256), { disposition: 'inline', contentType: DERIVED_TYPE })
      : null,
  };
}

async function detail(asset: AssetRow, viewer: Member) {
  const store = assetStore();
  const [uploaders, collections, similarRows, editable, manager] = await Promise.all([
    store.uploaders(asset.id),
    store.collectionsFor(asset.id),
    store.similarFor(asset.id),
    canEdit(viewer, asset),
    canManage(viewer),
  ]);
  const similarAssets = await store.getMany(similarRows.map((s) => s.id));
  const original = objectKeys.original(asset.sha256, asset.ext);
  return {
    ...(await card(asset)),
    sha256: asset.sha256,
    original_name: asset.original_name,
    member: {
      title: asset.title,
      description: asset.description,
      source: asset.source,
      tags: asset.tags,
      facets: asset.facets,
    },
    ai: {
      status: asset.ai_status,
      title: asset.ai_title,
      caption: asset.ai_caption,
      tags: asset.ai_tags,
      text: asset.ai_text,
      facets: asset.ai_facets,
      people: asset.ai_people,
      model: asset.ai_model,
      error: asset.ai_error,
      at: asset.ai_at,
    },
    verified: asset.verified_at !== null,
    preview_url: asset.has_preview
      ? await objects.readUrl(objectKeys.preview(asset.sha256), { disposition: 'inline', contentType: DERIVED_TYPE })
      : null,
    // Played or shown full size in place; HEIC/HEIF have no inline form, so they show the preview.
    media_url: INLINE_ORIGINALS.has(asset.content_type)
      ? await objects.readUrl(original, {
          disposition: 'inline',
          contentType: asset.content_type,
          expiresInSec: 6 * 3600,
        })
      : null,
    uploaders,
    collections,
    similar: await Promise.all(
      similarAssets
        .filter((a) => a.status === 'active')
        .map(async (a) => ({ ...(await card(a)), distance: similarRows.find((s) => s.id === a.id)?.distance ?? 0 })),
    ),
    can_edit: editable,
    can_manage: manager,
  };
}

function listQuery(c: Context<AppEnv>, me: Member): AssetListQuery | null {
  const q = c.req.query();
  let facets: FacetValues | undefined;
  if (q.facets) {
    try {
      const parsed = FacetsInput.safeParse(JSON.parse(q.facets));
      if (!parsed.success) return null;
      facets = parsed.data;
    } catch {
      return null;
    }
  }
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[]) =>
    value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
  return {
    q: q.q?.slice(0, 200),
    kind: pick(q.kind, ['image', 'video'] as const),
    facets,
    uploadedBy: q.uploaded_by === 'me' ? me.id : q.uploaded_by?.slice(0, 64),
    from: q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from).toISOString() : undefined,
    to: q.to && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to).toISOString() : undefined,
    orientation: pick(q.orientation, ['landscape', 'portrait', 'square'] as const),
    collectionId: q.collection?.slice(0, 64),
    ai: pick(q.ai, ['done', 'none'] as const),
    duplicates: q.duplicates === 'true',
    status: q.status === 'deleted' ? 'deleted' : 'active',
    sort: pick(q.sort, ['new', 'old', 'relevance'] as const),
    offset: Number.parseInt(q.offset ?? '0', 10) || 0,
    limit: Number.parseInt(q.limit ?? '60', 10) || 60,
  };
}

const UPLOAD_TTL_SEC = 3600;

/**
 * Targets for every object of an unfinished upload. The row remembers when they expire:
 * byte verification waits until then, so nobody can still overwrite what it checked.
 */
async function uploadTargets(asset: AssetRow) {
  await assetStore().setUploadExpiry(asset.id, new Date(Date.now() + (UPLOAD_TTL_SEC + 60) * 1000).toISOString());
  const target = (key: string, contentType: string, maxBytes: number) =>
    objects.uploadUrl({ key, contentType, maxBytes, expiresInSec: UPLOAD_TTL_SEC });
  return {
    original: await target(objectKeys.original(asset.sha256, asset.ext), asset.content_type, asset.size),
    ...(asset.has_preview
      ? {
          thumb: await target(objectKeys.thumb(asset.sha256), DERIVED_TYPE, MAX_THUMB_BYTES),
          preview: await target(objectKeys.preview(asset.sha256), DERIVED_TYPE, MAX_PREVIEW_BYTES),
          frames: await Promise.all(
            Array.from({ length: asset.frame_count }, (_, i) =>
              target(objectKeys.frame(asset.sha256, i), DERIVED_TYPE, MAX_FRAME_BYTES),
            ),
          ),
        }
      : {}),
  };
}

export const assetRoutes = new Hono<AppEnv>()
  .get('/config', async (c) => {
    const me = member(c);
    return run(c, 'listAssets', async () =>
      ok({
        facets: await assetStore().facetDefs(),
        can_manage: await canManage(me),
        ai_enabled: await aiEnabled(),
        direct_uploads: objects.direct,
        limits: { image_bytes: MAX_IMAGE_BYTES, video_bytes: MAX_VIDEO_BYTES, check_items: MAX_CHECK_ITEMS },
        types: { image: Object.keys(IMAGE_TYPES), video: Object.keys(VIDEO_TYPES) },
      }),
    );
  })
  .get('/stats', (c) => run(c, 'listAssets', async () => ok(await assetStore().counts())))

  // ── Upload ──

  .post('/uploads/check', async (c) => {
    const input = await body(
      c,
      z.object({
        items: z
          .array(z.object({ sha256: z.string().regex(SHA256), size: z.number().int().min(0) }))
          .min(1)
          .max(MAX_CHECK_ITEMS),
      }),
    );
    if (!input) return c.json({ error: 'items: 1–200 {sha256, size}' }, 400);
    const me = member(c);
    return run(c, 'listAssets', async () => {
      const rows = await assetStore().bySha([...new Set(input.items.map((i) => i.sha256))]);
      const bySha = new Map(rows.filter((r) => r.status !== 'invalid').map((r) => [r.sha256, r]));
      const manager = await canManage(me);
      return ok({
        results: await Promise.all(
          input.items.map(async (item) => {
            const row = bySha.get(item.sha256);
            if (!row) return { sha256: item.sha256, exists: false };
            // The bin is for managers: others learn only that the content is there.
            const hidden = (row.status === 'deleted' || row.status === 'purging') && !manager;
            return hidden
              ? { sha256: item.sha256, exists: true, binned: true }
              : { sha256: item.sha256, exists: true, asset: await card(row) };
          }),
        ),
      });
    });
  })

  .post('/uploads', async (c) => {
    const input = await body(c, UploadInput);
    if (!input) return c.json({ error: 'invalid upload' }, 400);
    const me = member(c);
    const kind = kindForType(input.content_type);
    if (!kind) return c.json({ error: `unsupported type ${input.content_type}` }, 415);
    if (input.size > maxBytesFor(kind)) return c.json({ error: 'file too large' }, 413);
    if (input.has_preview === false && input.frame_count > 0) return c.json({ error: 'frames need a preview' }, 400);
    const store = assetStore();
    const name = cleanFilename(input.filename);
    const fields = {
      title: input.title,
      description: input.description,
      source: input.source,
      tags: input.tags,
      facets: input.facets,
    };
    return run(c, 'uploadAsset', async () => {
      if (input.collection_id && !(await store.getCollection(input.collection_id)))
        return fail('NOT_FOUND', 'collection not found');
      const join = async (existing: AssetRow) => {
        if (existing.status === 'purging') return fail('CONFLICT', 'this file is being removed; try again in a minute');
        if (existing.status === 'uploading' && existing.uploaded_by === me.id)
          // The same person retrying an unfinished upload: hand the targets out again.
          return ok({ status: 'upload' as const, asset: await card(existing), targets: await uploadTargets(existing) });
        await store.recordUploader(existing.id, me.id, name);
        if (existing.status === 'deleted')
          // In the bin: only a manager sees what it is (and can restore it).
          return ok({ status: 'binned' as const, asset: (await canManage(me)) ? await card(existing) : null });
        const updated = (await store.contribute(existing.id, fields)) ?? existing;
        if (input.collection_id) await store.addToCollection(input.collection_id, [existing.id], me.id);
        return ok({ status: 'duplicate' as const, asset: await card(updated) });
      };
      let existing: AssetRow | undefined = (await store.bySha([input.sha256]))[0];
      if (existing?.status === 'invalid' && (await store.removeRow(existing.id, 'invalid'))) existing = undefined;
      if (existing) return join(existing);
      const created = await store.insertUploading({
        ...fields,
        kind,
        sha256: input.sha256,
        size: input.size,
        content_type: input.content_type,
        ext: IMAGE_TYPES[input.content_type] ?? VIDEO_TYPES[input.content_type]!,
        original_name: name,
        width: input.width,
        height: input.height,
        duration_ms: input.duration_ms,
        phash: input.phash,
        has_preview: input.has_preview,
        frame_count: input.frame_count,
        uploaded_by: me.id,
      });
      if (!created) {
        // Someone else created it a moment ago.
        const [raced] = await store.bySha([input.sha256]);
        return raced ? join(raced) : fail('CONFLICT', 'upload raced; try again');
      }
      await store.recordUploader(created.id, me.id, name);
      if (input.collection_id) await store.addToCollection(input.collection_id, [created.id], me.id);
      return ok({ status: 'upload' as const, asset: await card(created), targets: await uploadTargets(created) });
    });
  })

  .post('/assets/:id/complete', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    return run(
      c,
      'uploadAsset',
      async () => {
        const store = assetStore();
        const asset = await store.get(id);
        if (!asset || asset.status !== 'uploading') return fail('NOT_FOUND', 'no unfinished upload with this id');
        if (asset.uploaded_by !== me.id && !(await canManage(me))) return fail('FORBIDDEN', 'not your upload');
        // Trust the store, not the client: a direct upload is not size-capped by the bucket.
        const original = await objects.head(objectKeys.original(asset.sha256, asset.ext));
        if (!original || original.size !== asset.size)
          return fail('INVALID_INPUT', original ? 'the stored file has the wrong size' : 'the file was not uploaded');
        let preview = asset.has_preview;
        if (preview) {
          const sizes = await Promise.all([
            objects.head(objectKeys.thumb(asset.sha256)),
            objects.head(objectKeys.preview(asset.sha256)),
            ...Array.from({ length: asset.frame_count }, (_, i) => objects.head(objectKeys.frame(asset.sha256, i))),
          ]);
          const caps = [MAX_THUMB_BYTES, MAX_PREVIEW_BYTES, ...sizes.slice(2).map(() => MAX_FRAME_BYTES)];
          preview = sizes.every((s, i) => s !== null && s.size <= caps[i]);
        }
        if (!preview && asset.has_preview) await store.markPreviewMissing(asset.id);
        const active = await store.markActive(asset.id, preview && (await aiEnabled()) ? 'pending' : 'skipped');
        if (!active) return fail('CONFLICT', 'upload already completed');
        const similarHits = await store.recordSimilar(active);
        return ok({ asset: await card(active), similar: similarHits.length });
      },
      id,
    );
  })

  // ── Library ──

  .get('/assets', async (c) => {
    const me = member(c);
    const query = listQuery(c, me);
    if (!query) return c.json({ error: 'facets must be a JSON object of value lists' }, 400);
    const action: AssetsActionId = query.q ? 'searchAssets' : 'listAssets';
    return run(c, action, async () => {
      if (query.status === 'deleted' && !(await canManage(me))) return fail('FORBIDDEN', 'the bin is for managers');
      const { items, total } = await assetStore().list(query);
      return ok({ items: await Promise.all(items.map(card)), total, offset: query.offset ?? 0 });
    });
  })

  .get('/assets/:id', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    return run(
      c,
      'readAsset',
      async () => {
        const asset = await assetStore().get(id);
        if (!asset || asset.status === 'invalid' || asset.status === 'uploading') return fail('NOT_FOUND', 'not found');
        if (asset.status === 'deleted' && !(await canManage(me))) return fail('NOT_FOUND', 'not found');
        return ok({ asset: await detail(asset, me) });
      },
      id,
    );
  })

  .patch('/assets/:id', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    const input = await body(c, HumanInput);
    if (!input) return c.json({ error: 'invalid fields' }, 400);
    return run(
      c,
      'updateAsset',
      async () => {
        const store = assetStore();
        const asset = await store.get(id);
        if (!asset || asset.status !== 'active') return fail('NOT_FOUND', 'not found');
        if (!(await canEdit(me, asset)))
          return fail('FORBIDDEN', 'only its uploaders or a library manager can edit it');
        const updated = await store.update(id, input);
        return ok({ asset: await detail(updated!, me) });
      },
      id,
    );
  })

  .post('/assets/batch', async (c) => {
    const me = member(c);
    const input = await body(
      c,
      z.object({
        ids: Ids,
        add_tags: z.array(Text(40)).max(30).optional(),
        remove_tags: z.array(Text(40)).max(30).optional(),
        facets: FacetsInput.optional(),
      }),
    );
    if (!input) return c.json({ error: 'invalid batch' }, 400);
    return run(c, 'updateAsset', async () => {
      const store = assetStore();
      const manager = await canManage(me);
      let updated = 0;
      const skipped: string[] = [];
      for (const asset of await store.getMany(input.ids)) {
        if (asset.status !== 'active' || (!manager && !(await canEdit(me, asset)))) {
          skipped.push(asset.id);
          continue;
        }
        if (
          await store.adjust(asset.id, { addTags: input.add_tags, removeTags: input.remove_tags, facets: input.facets })
        )
          updated += 1;
        else skipped.push(asset.id);
      }
      return ok({ updated, skipped });
    });
  })

  .delete('/assets/:id', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    return run(
      c,
      'deleteAsset',
      async () => {
        if (!(await canManage(me))) return fail('FORBIDDEN', 'only a library manager can delete assets');
        const removed = await assetStore().softDelete(id, me.id);
        return removed ? ok({ ok: true }) : fail('NOT_FOUND', 'not found');
      },
      id,
    );
  })

  .post('/assets/:id/restore', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    return run(
      c,
      'deleteAsset',
      async () => {
        if (!(await canManage(me))) return fail('FORBIDDEN', 'only a library manager can restore assets');
        const restored = await assetStore().restore(id);
        return restored ? ok({ asset: await card(restored) }) : fail('NOT_FOUND', 'not in the bin');
      },
      id,
    );
  })

  .get('/assets/:id/download', async (c) => {
    const id = c.req.param('id');
    return run(
      c,
      'downloadAsset',
      async () => {
        const asset = await assetStore().get(id);
        if (!asset || asset.status !== 'active') return fail('NOT_FOUND', 'not found');
        const url = await objects.readUrl(objectKeys.original(asset.sha256, asset.ext), {
          disposition: 'attachment',
          filename: asset.original_name,
          expiresInSec: 300,
        });
        return ok({ url, filename: asset.original_name });
      },
      id,
    );
  })

  .post('/assets/:id/ai/retry', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    return run(
      c,
      'updateAsset',
      async () => {
        const store = assetStore();
        const asset = await store.get(id);
        if (!asset || asset.status !== 'active') return fail('NOT_FOUND', 'not found');
        if (!(await canEdit(me, asset))) return fail('FORBIDDEN', 'only its uploaders or a library manager can retry');
        if (!(await aiEnabled())) return fail('CONFLICT', 'AI cataloguing is switched off');
        const queued = await store.requeueAi(id);
        return queued ? ok({ asset: await card(queued) }) : fail('CONFLICT', 'this asset has no preview to analyze');
      },
      id,
    );
  })

  .post('/assets/:id/ai/accept', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    const input = await body(
      c,
      z.object({ fields: z.array(z.enum(['title', 'description', 'tags', 'facets'])).min(1) }),
    );
    if (!input) return c.json({ error: 'fields: title, description, tags, facets' }, 400);
    return run(
      c,
      'updateAsset',
      async () => {
        const store = assetStore();
        const asset = await store.get(id);
        if (!asset || asset.status !== 'active') return fail('NOT_FOUND', 'not found');
        if (!(await canEdit(me, asset)))
          return fail('FORBIDDEN', 'only its uploaders or a library manager can edit it');
        const updated = await store.acceptAi(asset.id, input.fields);
        if (!updated) return fail('NOT_FOUND', 'not found');
        return ok({ asset: await detail(updated!, me) });
      },
      id,
    );
  })

  // ── Collections ──

  .get('/collections', (c) =>
    run(c, 'listAssets', async () => ok({ collections: await assetStore().listCollections() })),
  )

  .post('/collections', async (c) => {
    const me = member(c);
    const input = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(100), description: Text(1000).nullish() }),
    );
    if (!input) return c.json({ error: 'name: 1–100 characters' }, 400);
    return run(c, 'manageCollections', async () =>
      ok({ collection: await assetStore().createCollection(input.name, input.description?.trim() || null, me.id) }),
    );
  })

  .patch('/collections/:id', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    const input = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(100).optional(), description: Text(1000).nullish() }),
    );
    if (!input) return c.json({ error: 'invalid collection' }, 400);
    return run(
      c,
      'manageCollections',
      async () => {
        const store = assetStore();
        const collection = await store.getCollection(id);
        if (!collection) return fail('NOT_FOUND', 'not found');
        if (collection.created_by !== me.id && !(await canManage(me)))
          return fail('FORBIDDEN', 'only its creator or a library manager can change it');
        return ok({
          collection: await store.updateCollection(id, {
            ...(input.name ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          }),
        });
      },
      id,
    );
  })

  .delete('/collections/:id', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    return run(
      c,
      'manageCollections',
      async () => {
        const store = assetStore();
        const collection = await store.getCollection(id);
        if (!collection) return fail('NOT_FOUND', 'not found');
        if (collection.created_by !== me.id && !(await canManage(me)))
          return fail('FORBIDDEN', 'only its creator or a library manager can delete it');
        await store.deleteCollection(id);
        return ok({ ok: true });
      },
      id,
    );
  })

  .post('/collections/:id/items', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    const input = await body(c, z.object({ asset_ids: Ids }));
    if (!input) return c.json({ error: 'asset_ids: 1–500 ids' }, 400);
    return run(
      c,
      'manageCollections',
      async () => {
        const store = assetStore();
        if (!(await store.getCollection(id))) return fail('NOT_FOUND', 'not found');
        const active = (await store.getMany(input.asset_ids)).filter((a) => a.status === 'active').map((a) => a.id);
        await store.addToCollection(id, active, me.id);
        return ok({ added: active.length });
      },
      id,
    );
  })

  .delete('/collections/:id/items', async (c) => {
    const me = member(c);
    const id = c.req.param('id');
    const input = await body(c, z.object({ asset_ids: Ids }));
    if (!input) return c.json({ error: 'asset_ids: 1–500 ids' }, 400);
    return run(
      c,
      'manageCollections',
      async () => {
        const store = assetStore();
        const collection = await store.getCollection(id);
        if (!collection) return fail('NOT_FOUND', 'not found');
        if (collection.created_by !== me.id && !(await canManage(me)))
          return fail('FORBIDDEN', 'only its creator or a library manager can remove assets from it');
        await store.removeFromCollection(id, input.asset_ids);
        return ok({ ok: true });
      },
      id,
    );
  })

  // ── Managers ──

  .get('/facets', (c) => run(c, 'listAssets', async () => ok({ facets: await assetStore().facetDefs() })))

  .put('/facets', async (c) => {
    const me = member(c);
    const input = await body(
      c,
      z.object({
        facets: z
          .array(
            z.object({
              key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
              label_en: z.string().trim().min(1).max(60),
              label_zh: z.string().trim().min(1).max(60),
              multiple: z.boolean(),
              values: z
                .array(
                  z.object({ value: z.string().trim().min(1).max(120), zh: z.string().trim().max(120).optional() }),
                )
                .max(300),
            }),
          )
          .max(20),
      }),
    );
    if (!input) return c.json({ error: 'invalid facets' }, 400);
    const keys = input.facets.map((f) => f.key);
    if (new Set(keys).size !== keys.length) return c.json({ error: 'facet keys must be unique' }, 400);
    return run(c, 'manageLibrary', async () => {
      if (!(await canManage(me))) return fail('FORBIDDEN', 'only a library manager can change facets');
      const facets = input.facets.map((f) => ({
        ...f,
        values: [...new Map(f.values.map((v) => [v.value, v.zh ? v : { value: v.value }])).values()],
      }));
      return ok({ facets: await assetStore().replaceFacets(facets) });
    });
  })

  .get('/duplicates', async (c) => {
    const me = member(c);
    const offset = Number.parseInt(c.req.query('offset') ?? '0', 10) || 0;
    return run(c, 'listAssets', async () => {
      if (!(await canManage(me))) return fail('FORBIDDEN', 'only a library manager reviews duplicates');
      const store = assetStore();
      const pairs = await store.openPairs(50, offset);
      const rows = new Map(
        (await store.getMany([...new Set(pairs.flatMap((p) => [p.asset_id, p.other_id]))])).map((r) => [r.id, r]),
      );
      return ok({
        pairs: await Promise.all(
          pairs
            .filter((p) => rows.has(p.asset_id) && rows.has(p.other_id))
            .map(async (p) => ({
              distance: p.distance,
              a: await card(rows.get(p.asset_id)!),
              b: await card(rows.get(p.other_id)!),
            })),
        ),
      });
    });
  })

  .post('/duplicates/merge', async (c) => {
    const me = member(c);
    const input = await body(c, z.object({ keep: z.string().max(64), drop: z.string().max(64) }));
    if (!input || input.keep === input.drop) return c.json({ error: 'keep and drop: two different asset ids' }, 400);
    return run(
      c,
      'manageLibrary',
      async () => {
        if (!(await canManage(me))) return fail('FORBIDDEN', 'only a library manager merges duplicates');
        return (await assetStore().merge(input.keep, input.drop, me.id))
          ? ok({ ok: true })
          : fail('NOT_FOUND', 'no open pair for these assets');
      },
      input.drop,
    );
  })

  .post('/duplicates/dismiss', async (c) => {
    const me = member(c);
    const input = await body(c, z.object({ a: z.string().max(64), b: z.string().max(64) }));
    if (!input || input.a === input.b) return c.json({ error: 'a and b: two different asset ids' }, 400);
    return run(c, 'manageLibrary', async () => {
      if (!(await canManage(me))) return fail('FORBIDDEN', 'only a library manager dismisses duplicates');
      return (await assetStore().resolvePair(input.a, input.b, 'dismissed', me.id))
        ? ok({ ok: true })
        : fail('NOT_FOUND', 'no open pair for these assets');
    });
  });
