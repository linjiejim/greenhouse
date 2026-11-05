/**
 * AI cataloguing: one metered vision call per asset (preview, or a video's poster and
 * keyframes) that suggests a title, a description, tags, the text visible in the frame,
 * facet values from the configured vocabulary, and whether recognisable people appear.
 * Suggestions land in the `ai_*` columns; nothing a member wrote is touched.
 */
import { analyzeImages, getWorkspaceFlag, getWorkspaceValue, pluginObjects } from '@greenhouse/api/extension-kit';
import { MAX_FRAMES, objectKeys } from './model.js';
import type { AiFields } from './store.js';
import type { AssetRow, FacetRow, FacetValues } from './schema.js';

export const objects = pluginObjects('assets');

export async function aiEnabled(): Promise<boolean> {
  return getWorkspaceFlag('assets.ai_enabled');
}

export async function aiLanguage(): Promise<'zh' | 'en'> {
  return (await getWorkspaceValue('assets.ai_language')) === 'en' ? 'en' : 'zh';
}

export function buildPrompt(asset: AssetRow, defs: readonly FacetRow[], language: 'zh' | 'en'): string {
  const vocabulary = defs.map((def) => ({
    key: def.key,
    label: language === 'zh' ? def.label_zh : def.label_en,
    multiple: def.multiple,
    values: def.values.map((v) => (v.zh && language === 'zh' ? `${v.value} (${v.zh})` : v.value)),
  }));
  const known = {
    file_name: asset.original_name,
    kind: asset.kind,
    ...(asset.title ? { title: asset.title } : {}),
    ...(asset.description ? { description: asset.description } : {}),
    ...(asset.tags.length ? { tags: asset.tags } : {}),
    ...(Object.keys(asset.facets).length ? { facets: asset.facets } : {}),
  };
  const frames =
    asset.kind === 'video'
      ? 'The images are frames from one video: its poster first, then frames from early, middle and late in it.'
      : 'The image is a preview of the asset.';
  return `You are cataloguing an asset in a team's shared image and video library so that colleagues can find it by searching. ${frames}

What the team already knows (treat it as true; never contradict it):
${JSON.stringify(known)}

Facet vocabulary (choose values only from these lists and answer with the value before any parentheses, e.g. "basil"; leave a facet out when unsure):
${JSON.stringify(vocabulary)}

Reply with one JSON object:
{"title": short descriptive title (max 60 characters),
 "caption": one or two sentences describing what is shown and what it could be used for,
 "tags": 3 to 10 short search keywords (objects, scene, setting, style, colours),
 "text": the text visible in the frame, transcribed exactly ("" if none),
 "facets": {"<facet key>": ["<value>", …]},
 "people": true if recognisable people appear, else false}

Write title, caption and tags in ${language === 'zh' ? 'Simplified Chinese' : 'English'}. Describe only what is visible; never guess brands, model numbers or names that cannot be read in the frame.`;
}

const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** Read the model's JSON defensively: wrong types are dropped, facet keys checked later by the store. */
export function parseAiReply(reply: unknown, defs: readonly FacetRow[], model: string): AiFields {
  const r = reply && typeof reply === 'object' && !Array.isArray(reply) ? (reply as Record<string, unknown>) : {};
  const facets: FacetValues = {};
  if (r.facets && typeof r.facets === 'object' && !Array.isArray(r.facets))
    for (const def of defs) {
      // Models echo a value as shown ("basil (罗勒)"), by its Chinese name, or under the facet's label.
      const byName = new Map<string, string>();
      for (const v of def.values) {
        byName.set(v.value.toLowerCase(), v.value);
        if (v.zh) byName.set(v.zh.toLowerCase(), v.value);
      }
      const given = r.facets as Record<string, unknown>;
      const raw = given[def.key] ?? given[def.label_zh] ?? given[def.label_en];
      const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
        .filter((v): v is string => typeof v === 'string')
        .map((v) => {
          const plain = v.trim().toLowerCase();
          return byName.get(plain) ?? byName.get(plain.replace(/\s*[(（].*[)）]\s*$/, ''));
        })
        .filter((v): v is string => Boolean(v));
      if (values.length) facets[def.key] = [...new Set(values)];
    }
  return {
    title: str(r.title, 200),
    caption: str(r.caption, 4000),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    text: str(r.text, 4000),
    facets,
    people: typeof r.people === 'boolean' ? r.people : null,
    model,
  };
}

/** The images the model sees: the preview (a video's poster) and up to three keyframes. */
export async function visionImages(asset: AssetRow): Promise<Buffer[]> {
  const keys = [objectKeys.preview(asset.sha256)];
  if (asset.kind === 'video')
    for (let i = 0; i < Math.min(asset.frame_count, MAX_FRAMES); i++) keys.push(objectKeys.frame(asset.sha256, i));
  const images: Buffer[] = [];
  for (const key of keys) {
    const object = await objects.get(key);
    if (object) images.push(object.buffer);
  }
  return images;
}

/** One vision call for one asset, charged to `userId` (the uploader). */
export async function extractAsset(asset: AssetRow, defs: readonly FacetRow[], userId: string): Promise<AiFields> {
  const images = await visionImages(asset);
  if (!images.length) throw new Error('No preview to analyze');
  const result = await analyzeImages({
    userId,
    images: images.map((bytes) => ({ bytes })),
    prompt: buildPrompt(asset, defs, await aiLanguage()),
    json: true,
    maxOutputTokens: 900,
    caller: 'assets',
    client: 'automation',
    metadata: { asset_id: asset.id },
  });
  if (result.json === undefined) throw new Error('The model did not return JSON');
  return parseAiReply(result.json, defs, result.model);
}
