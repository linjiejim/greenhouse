/**
 * Asset library limits, accepted types, object keys and the derived text columns.
 *
 * Objects are content-addressed: everything about one file lives under
 * `assets/<sha256>/` in the plugin object store, so a second upload of the same bytes
 * lands on the same keys and the database row is the only thing that is ever unique.
 */
import { randomBytes } from 'node:crypto';
import { segmentForFts } from '@greenhouse/api/extension-kit';
import type { AssetKind, FacetRow, FacetValues } from './schema.js';

export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1024 * 1024;
export const MAX_PREVIEW_BYTES = 6 * 1024 * 1024;
export const MAX_FRAME_BYTES = 3 * 1024 * 1024;
export const MAX_FRAMES = 3;
export const MAX_CHECK_ITEMS = 200;
export const MAX_TAGS = 30;
export const MAX_TAG_CHARS = 40;
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_SOURCE_CHARS = 500;
export const MAX_FILENAME_CHARS = 255;
/** Hamming distance between two 64-bit dHashes at or under which two assets look alike. */
export const SIMILAR_DISTANCE = 6;
/** Days a deleted asset stays in the bin before its row and objects are removed. */
export const BIN_DAYS = 30;
/** Hours an upload may stay unfinished before it is cleaned up. */
export const STALE_UPLOAD_HOURS = 24;

/** Accepted originals: content type → extension of the object key. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
export const VIDEO_TYPES: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export function kindForType(contentType: string): AssetKind | null {
  if (IMAGE_TYPES[contentType]) return 'image';
  if (VIDEO_TYPES[contentType]) return 'video';
  return null;
}

export function maxBytesFor(kind: AssetKind): number {
  return kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

/** Derived images are always JPEG: every browser can encode it (Safari cannot encode WebP). */
export const DERIVED_TYPE = 'image/jpeg';

export const objectKeys = {
  /** Where one upload attempt's browser writes land, before complete publishes them. */
  staging: (assetId: string, generation: string, name: string) => `staging/${assetId}/${generation}/${name}`,
  stagingRoot: (assetId: string) => `staging/${assetId}/`,
  original: (sha256: string, ext: string) => `assets/${sha256}/original.${ext}`,
  thumb: (sha256: string) => `assets/${sha256}/thumb.jpg`,
  preview: (sha256: string) => `assets/${sha256}/preview.jpg`,
  frame: (sha256: string, index: number) => `assets/${sha256}/frame-${index}.jpg`,
};

export const SHA256 = /^[0-9a-f]{64}$/;
export const PHASH = /^[0-9a-f]{16}$/;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A sortable id (`ast_01J…`): 48-bit time plus 80 random bits, ULID-shaped. */
export function newAssetId(prefix: 'ast' | 'acl'): string {
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[bytes[i] % 32];
  return `${prefix}_${head}${tail}`;
}

/** Popcount of the XOR of two 16-hex dHashes. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Trimmed, de-duplicated (case-insensitively), bounded tags. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = String(raw).trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_CHARS);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Facet values kept only when the facet exists and offers the value; single-choice
 * facets keep their first value. Unknown keys and values are dropped, never stored.
 */
export function normalizeFacets(input: FacetValues | undefined, defs: readonly FacetRow[]): FacetValues {
  const out: FacetValues = {};
  for (const def of defs) {
    const wanted = input?.[def.key];
    if (!Array.isArray(wanted)) continue;
    const allowed = new Set(def.values.map((v) => v.value));
    const values = [...new Set(wanted.map(String))].filter((v) => allowed.has(v));
    if (values.length) out[def.key] = def.multiple ? values : values.slice(0, 1);
  }
  return out;
}

/** Union of two facet selections (used when a second uploader adds to an asset). */
export function mergeFacets(a: FacetValues, b: FacetValues, defs: readonly FacetRow[]): FacetValues {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const merged: FacetValues = {};
  for (const key of keys) merged[key] = [...new Set([...(a[key] ?? []), ...(b[key] ?? [])])];
  return normalizeFacets(merged, defs);
}

export interface SearchSource {
  title: string | null;
  ai_title: string | null;
  tags: string[];
  ai_tags: string[];
  facets: FacetValues;
  ai_facets: FacetValues;
  description: string | null;
  ai_caption: string | null;
  ai_text: string | null;
  original_name: string;
  source: string | null;
}

/** Facet values and their labels, so `basil` and `罗勒` both find the asset. */
function facetText(values: FacetValues, defs: readonly FacetRow[]): string {
  const parts: string[] = [];
  for (const def of defs)
    for (const value of values[def.key] ?? []) {
      const label = def.values.find((v) => v.value === value);
      parts.push(value, label?.zh ?? '');
    }
  return parts.join(' ');
}

export function searchColumnsFor(row: SearchSource, defs: readonly FacetRow[]) {
  const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' ');
  return {
    search_a: segmentForFts(
      join(
        row.title,
        row.ai_title,
        row.tags.join(' '),
        row.ai_tags.join(' '),
        facetText(row.facets, defs),
        facetText(row.ai_facets, defs),
      ),
    ),
    search_b: segmentForFts(join(row.description, row.ai_caption)),
    search_c: segmentForFts(join(row.ai_text, row.original_name.replace(/[._-]+/g, ' '), row.source)),
  };
}

/** What a list shows as the asset's name: the member's title, else the AI's, else the file name. */
export function displayTitleFor(row: Pick<SearchSource, 'title' | 'ai_title' | 'original_name'>): string {
  return (row.title?.trim() || row.ai_title?.trim() || row.original_name).slice(0, MAX_TITLE_CHARS);
}

/** The file name without any path, control characters or excess length. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const printable = [...base].filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f).join('');
  return printable.trim().slice(0, MAX_FILENAME_CHARS) || 'file';
}
