import { embedFetch } from './embed';
import type {
  AssetCard,
  AssetDetail,
  Collection,
  Facet,
  FacetValues,
  LibraryConfig,
  ListFilters,
  UploadTarget,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await embedFetch(`/api/ext/assets${path}`, {
    ...rest,
    ...(json !== undefined
      ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json', ...rest.headers } }
      : {}),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status);
  return body as T;
}

export interface UploadFacts {
  sha256: string;
  size: number;
  filename: string;
  content_type: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  phash?: string | null;
  has_preview: boolean;
  frame_count: number;
  title?: string | null;
  description?: string | null;
  source?: string | null;
  tags?: string[];
  facets?: FacetValues;
  collection_id?: string | null;
}

export type UploadStart =
  | {
      status: 'upload';
      asset: AssetCard;
      targets: { original: UploadTarget; thumb?: UploadTarget; preview?: UploadTarget; frames?: UploadTarget[] };
    }
  | { status: 'duplicate'; asset: AssetCard }
  /** In the bin; only managers are told which asset it is. */
  | { status: 'binned'; asset: AssetCard | null };

export interface HumanPatch {
  title?: string | null;
  description?: string | null;
  source?: string | null;
  tags?: string[];
  facets?: FacetValues;
}

function listParams(filters: ListFilters, offset: number, limit: number): string {
  const p = new URLSearchParams();
  if (filters.q.trim()) p.set('q', filters.q.trim());
  if (filters.kind) p.set('kind', filters.kind);
  const facets = Object.fromEntries(Object.entries(filters.facets).filter(([, v]) => v.length));
  if (Object.keys(facets).length) p.set('facets', JSON.stringify(facets));
  if (filters.uploaded_by) p.set('uploaded_by', filters.uploaded_by);
  if (filters.orientation) p.set('orientation', filters.orientation);
  if (filters.collection) p.set('collection', filters.collection);
  if (filters.ai) p.set('ai', filters.ai);
  if (filters.duplicates) p.set('duplicates', 'true');
  if (filters.status === 'deleted') p.set('status', 'deleted');
  p.set('sort', filters.q.trim() && filters.sort === 'new' ? 'relevance' : filters.sort);
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  return p.toString();
}

export const api = {
  config: () => call<LibraryConfig>('/config'),
  stats: () => call<{ active: number; images: number; videos: number; bytes: number }>('/stats'),
  list: (filters: ListFilters, offset = 0, limit = 60) =>
    call<{ items: AssetCard[]; total: number }>(`/assets?${listParams(filters, offset, limit)}`),
  get: (id: string) => call<{ asset: AssetDetail }>(`/assets/${encodeURIComponent(id)}`),
  update: (id: string, patch: HumanPatch) =>
    call<{ asset: AssetDetail }>(`/assets/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch }),
  batch: (input: { ids: string[]; add_tags?: string[]; remove_tags?: string[]; facets?: FacetValues }) =>
    call<{ updated: number; skipped: string[] }>('/assets/batch', { method: 'POST', json: input }),
  remove: (id: string) => call<{ ok: true }>(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  restore: (id: string) => call<{ asset: AssetCard }>(`/assets/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  download: (id: string) => call<{ url: string; filename: string }>(`/assets/${encodeURIComponent(id)}/download`),
  retryAi: (id: string) => call<{ asset: AssetCard }>(`/assets/${encodeURIComponent(id)}/ai/retry`, { method: 'POST' }),
  acceptAi: (id: string, fields: Array<'title' | 'description' | 'tags' | 'facets'>) =>
    call<{ asset: AssetDetail }>(`/assets/${encodeURIComponent(id)}/ai/accept`, { method: 'POST', json: { fields } }),

  check: (items: Array<{ sha256: string; size: number }>) =>
    call<{ results: Array<{ sha256: string; exists: boolean; binned?: boolean; asset?: AssetCard }> }>('/uploads/check', {
      method: 'POST',
      json: { items },
    }),
  startUpload: (facts: UploadFacts) => call<UploadStart>('/uploads', { method: 'POST', json: facts }),
  completeUpload: (id: string) =>
    call<{ asset: AssetCard; similar: number }>(`/assets/${encodeURIComponent(id)}/complete`, { method: 'POST' }),

  collections: () => call<{ collections: Collection[] }>('/collections'),
  createCollection: (name: string, description?: string) =>
    call<{ collection: Collection }>('/collections', { method: 'POST', json: { name, description } }),
  updateCollection: (id: string, fields: { name?: string; description?: string | null }) =>
    call<{ collection: Collection }>(`/collections/${encodeURIComponent(id)}`, { method: 'PATCH', json: fields }),
  deleteCollection: (id: string) => call<{ ok: true }>(`/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addToCollection: (id: string, assetIds: string[]) =>
    call<{ added: number }>(`/collections/${encodeURIComponent(id)}/items`, { method: 'POST', json: { asset_ids: assetIds } }),
  removeFromCollection: (id: string, assetIds: string[]) =>
    call<{ ok: true }>(`/collections/${encodeURIComponent(id)}/items`, {
      method: 'DELETE',
      json: { asset_ids: assetIds },
    }),

  saveFacets: (facets: Facet[]) => call<{ facets: Facet[] }>('/facets', { method: 'PUT', json: { facets } }),
  duplicates: (offset = 0) =>
    call<{ pairs: Array<{ distance: number; a: AssetCard; b: AssetCard }> }>(`/duplicates?offset=${offset}`),
  merge: (keep: string, drop: string) => call<{ ok: true }>('/duplicates/merge', { method: 'POST', json: { keep, drop } }),
  dismiss: (a: string, b: string) => call<{ ok: true }>('/duplicates/dismiss', { method: 'POST', json: { a, b } }),

  people: async (): Promise<Array<{ id: string; name: string }>> => {
    const response = await embedFetch('/api/people');
    if (!response.ok) return [];
    return ((await response.json()) as { people: Array<{ id: string; name: string }> }).people;
  },
};
