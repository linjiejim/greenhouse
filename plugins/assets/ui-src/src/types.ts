export type AssetKind = 'image' | 'video';
export type AiStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type FacetValues = Record<string, string[]>;

export interface AssetCard {
  id: string;
  kind: AssetKind;
  status: 'uploading' | 'active' | 'invalid' | 'deleted';
  title: string;
  title_from: 'member' | 'ai' | 'file';
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  has_preview: boolean;
  ai_status: AiStatus;
  uploaded_by: string;
  created_at: string;
  deleted_at: string | null;
  thumb_url: string | null;
}

export interface AssetDetail extends AssetCard {
  sha256: string;
  original_name: string;
  member: { title: string | null; description: string | null; source: string | null; tags: string[]; facets: FacetValues };
  ai: {
    status: AiStatus;
    title: string | null;
    caption: string | null;
    tags: string[];
    text: string | null;
    facets: FacetValues;
    people: boolean | null;
    model: string | null;
    error: string | null;
    at: string | null;
  };
  verified: boolean;
  preview_url: string | null;
  media_url: string | null;
  uploaders: Array<{ user_id: string; original_name: string; created_at: string }>;
  collections: Array<{ id: string; name: string }>;
  similar: Array<AssetCard & { distance: number }>;
  can_edit: boolean;
  can_manage: boolean;
}

export interface FacetValue {
  value: string;
  zh?: string;
}

export interface Facet {
  key: string;
  label_en: string;
  label_zh: string;
  values: FacetValue[];
  multiple: boolean;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  count: number;
}

export interface LibraryConfig {
  facets: Facet[];
  can_manage: boolean;
  ai_enabled: boolean;
  direct_uploads: boolean;
  limits: { image_bytes: number; video_bytes: number; check_items: number };
  types: { image: string[]; video: string[] };
}

export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  direct: boolean;
}

export interface ListFilters {
  q: string;
  kind: '' | AssetKind;
  facets: FacetValues;
  uploaded_by: string;
  orientation: '' | 'landscape' | 'portrait' | 'square';
  collection: string;
  ai: '' | 'done' | 'none';
  duplicates: boolean;
  sort: 'new' | 'old' | 'relevance';
  status: 'active' | 'deleted';
}
