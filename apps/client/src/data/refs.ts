/**
 * Titles of the objects links point at, as `POST /api/refs/resolve` `{ urls }` answers them:
 * `{ items: [{ url, type, id, title, meta? }] }`. React-free (./refs.test.ts). `title: null`
 * means the member may not see the object: its chip shows only the type.
 */

export interface RefInfo {
  type: string;
  id: string;
  /** null: not visible to this member. */
  title: string | null;
  size?: number;
  contentType?: string;
}

/** The answer as url → info; anything malformed is skipped. */
export function parseResolved(body: unknown): Map<string, RefInfo> {
  const out = new Map<string, RefInfo>();
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return out;
  for (const raw of items) {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item.url !== 'string') continue;
    const meta = item.meta && typeof item.meta === 'object' ? (item.meta as Record<string, unknown>) : {};
    out.set(item.url, {
      type: typeof item.type === 'string' ? item.type : '',
      id: item.id == null ? '' : String(item.id),
      title: typeof item.title === 'string' && item.title.trim() ? item.title : null,
      ...(typeof meta.size === 'number' ? { size: meta.size } : {}),
      ...(typeof meta.contentType === 'string' ? { contentType: meta.contentType } : {}),
    });
  }
  return out;
}

/** How many links go in one request. */
export const RESOLVE_BATCH = 50;
