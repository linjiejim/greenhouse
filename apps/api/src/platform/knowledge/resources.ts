/**
 * MCP Resource projection for Knowledge documents.
 *
 * Listing and direct reads use the same owner/team/share/group ACL as the Web
 * and Tool surfaces. A caller cannot discover a private document URI unless it
 * can also read that document, and direct URI probing returns not-found.
 */

import type { DatabaseProvider, KnowledgeDocRow } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
import { canRead, resolveKbAccess } from '../../knowledge/access.js';

export const KNOWLEDGE_RESOURCE_URI_TEMPLATE = 'greenhouse://knowledge/doc/{slug}';

export interface KnowledgeResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description?: string;
  mimeType: 'text/markdown';
  annotations: {
    audience: ['assistant', 'user'];
    lastModified?: string;
  };
}

function resourceUri(slug: string): string {
  return `greenhouse://knowledge/doc/${encodeURIComponent(slug)}`;
}

function normalizedTimestamp(value: string | null): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function descriptor(doc: KnowledgeDocRow): KnowledgeResourceDescriptor {
  const lastModified = normalizedTimestamp(doc.updated_at);
  return {
    uri: resourceUri(doc.doc_id),
    name: doc.doc_id,
    title: doc.title,
    description: doc._summary || undefined,
    mimeType: 'text/markdown',
    annotations: {
      audience: ['assistant', 'user'],
      ...(lastModified ? { lastModified } : {}),
    },
  };
}

export async function listKnowledgeResources(
  db: DatabaseProvider,
  userId: string,
  limit = 500,
): Promise<KnowledgeResourceDescriptor[]> {
  const [team, own, sharedIds] = await Promise.all([
    db.knowledgeBase.list({
      scope: 'shared',
      status: 'published',
      visibility: 'team',
      limit,
    }),
    db.knowledgeBase.list({
      scope: 'shared',
      status: 'published',
      visibility: 'private',
      ownerUserId: userId,
      limit,
    }),
    db.knowledgeShares.listDocIdsForUser(userId),
  ]);
  const shared = (
    await db.knowledgeBase.listByIds(sharedIds.slice(0, limit), {
      status: 'published',
    })
  ).filter((doc) => doc.visibility === 'private' && doc.owner_user_id !== userId);
  const unique = new Map<number, KnowledgeDocRow>();
  for (const doc of [...team, ...own, ...shared]) unique.set(doc.id, doc);
  return [...unique.values()]
    .sort((left, right) => new Date(right.updated_at ?? 0).getTime() - new Date(left.updated_at ?? 0).getTime())
    .slice(0, limit)
    .map(descriptor);
}

export function parseKnowledgeResourceUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'greenhouse:' || parsed.hostname !== 'knowledge') return undefined;
    const match = parsed.pathname.match(/^\/doc\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    return undefined;
  }
}

export async function readKnowledgeResource(
  db: DatabaseProvider,
  userId: string,
  uri: string,
): Promise<{ uri: string; mimeType: 'text/markdown'; text: string } | undefined> {
  const slug = parseKnowledgeResourceUri(uri);
  if (!slug) return undefined;
  const doc = await db.knowledgeBase.get(slug, 'shared');
  if (!doc || doc.status !== 'published') return undefined;
  const access = await resolveKbAccess(db, doc, userId);
  if (!canRead(access)) return undefined;

  const meta = safeJsonParse(doc.meta, {}) as Record<string, unknown>;
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(doc.title)}`,
    `slug: ${JSON.stringify(doc.doc_id)}`,
    `visibility: ${JSON.stringify(doc.visibility)}`,
    `updated_at: ${JSON.stringify(doc.updated_at)}`,
    ...(typeof meta.space === 'string' ? [`space: ${JSON.stringify(meta.space)}`] : []),
    '---',
    '',
  ].join('\n');
  return {
    uri: resourceUri(doc.doc_id),
    mimeType: 'text/markdown',
    text: `${frontmatter}${doc.content}`,
  };
}
