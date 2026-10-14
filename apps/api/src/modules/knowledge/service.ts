/**
 * The knowledge base (KNOW-01 to KNOW-16, AGNT-17): one tree per space with folders, docs and
 * files; Markdown docs with compare-and-set saves and immutable versions; links, comments,
 * shares, presence, files, exports and full-text search. Routes and the Agent tools call this
 * service, and it checks access on every call (access.ts).
 */

import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type {
  CreateDocInput,
  CreateFolderInput,
  DocDiff,
  DocPresence,
  DocVersion,
  DocVersionDetail,
  KnowledgeComment,
  KnowledgeDoc,
  KnowledgeFile,
  KnowledgeFolder,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSearchHit,
  KnowledgeShares,
  KnowledgeSpace,
  Page,
  PathEntry,
  PresenceState,
  RealtimeEvent,
  ReorderInput,
  ShareInput,
  UpdateDocInput,
  UpdateFileInput,
  UpdateFolderInput,
} from '@greenhouse/contract';
import {
  comments,
  docLinks,
  docVersions,
  docs,
  files,
  folders,
  getDb,
  groupMembers,
  groups,
  MAX_INDEXED_CHARS,
  members,
  newId,
  queryWords,
  searchQuery,
  searchTokens,
  shares,
  transaction,
  type Agent,
  type CommentRow,
  type DocMeta,
  type DocRow,
  type FileRow,
  type FolderRow,
} from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, conflict, forbidden, invalidInput, notFound } from '../../http/errors.js';
import { containing } from '../../http/like.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import type { Hub } from '../../realtime/hub.js';
import { exportFilename } from '../conversations/export.js';
import type { FilesService } from '../files/service.js';
import { fileText } from '../files/text.js';
import type { NotificationsService } from '../notifications/service.js';
import {
  agentOfChain,
  atLeast,
  chainOf,
  docShareRoles,
  inList,
  loadReader,
  MAX_FOLDER_DEPTH,
  principalMatch,
  readableWhere,
  roleIn,
  rolesOf,
  subtree,
  walkDown,
  walkUp,
  type Reader,
  type Role,
} from './access.js';
import { diffText } from './diff.js';
import { exportCopy, notesEntry, planExport, safeSegment, zipStream, type ExportFile } from './export.js';
import { docLinkIds, docSnippet, fileLinks, markdownText, mentionIds, snippetFor } from './markdown.js';
import { createPresence } from './presence.js';
import {
  agentNames,
  docSource,
  fileSource,
  folderSource,
  memberNames,
  refOf,
  shareViews,
  toItem,
  treeOrder,
  type Source,
} from './views.js';

/**
 * The tree's lock, in any process and only inside a transaction. A folder move holds it alone,
 * so the cycle and depth checks see every move before it; whatever depends on where a folder
 * sits (creating in it, uploading to it, sharing it, moving a doc or file) holds it shared and
 * reads the place again under it.
 */
const TREE_LOCK = 74_192_101;
const lockTree = (mode: 'move' | 'place') =>
  getDb().execute(
    mode === 'move'
      ? sql`SELECT pg_advisory_xact_lock(${TREE_LOCK})`
      : sql`SELECT pg_advisory_xact_lock_shared(${TREE_LOCK})`,
  );
const tooDeep = () => conflict('folder_too_deep', `Folders nest at most ${MAX_FOLDER_DEPTH} levels deep.`);
/** A folder shows at most this many items of each kind. */
const MAX_CHILDREN = 1000;
/** Text read from an uploaded file that goes into search. */
const MAX_FILE_TEXT = 20_000;
/** Mentions and comment followers told about one change. */
const MAX_TOLD = 50;

/** In an Agent's turn: the Agent that reads or writes for the member. */
export interface As {
  agentId?: string | null;
}

interface Place {
  folder: FolderRow | null;
  chain: FolderRow[];
  space: KnowledgeSpace;
  ownerId: string | null;
  /** The Agent whose private folder this is in. */
  agentId: string | null;
}

const docListColumns = {
  id: docs.id,
  title: docs.title,
  space: docs.space,
  folderId: docs.folderId,
  ownerId: docs.ownerId,
  sortOrder: docs.sortOrder,
  isTemplate: docs.isTemplate,
  archivedAt: docs.archivedAt,
  updatedAt: docs.updatedAt,
};

const fileListColumns = {
  id: files.id,
  name: files.name,
  space: files.space,
  folderId: files.folderId,
  ownerId: files.ownerId,
  contentType: files.contentType,
  sizeBytes: files.sizeBytes,
  archivedAt: files.archivedAt,
  updatedAt: files.updatedAt,
  meta: files.meta,
};

/** Knowledge files of the tree: not the pictures that belong to a doc. */
const treeFile = () =>
  and(eq(files.purpose, 'knowledge'), eq(files.status, 'active'), sql`${files.meta}->>'doc_id' IS NULL`);

function docSearchColumns(fields: { title: string; tags: string[]; meta: DocMeta; content: string }) {
  return {
    searchA: searchTokens(fields.title, fields.tags.join(' ')),
    searchB: searchTokens(
      fields.meta.summary,
      (fields.meta.questions ?? []).join('\n'),
      (fields.meta.topics ?? []).join(' '),
    ),
    // Only what gets indexed is cleaned: a long doc costs no more than the index keeps.
    searchC: searchTokens(markdownText(fields.content.slice(0, MAX_INDEXED_CHARS))),
  };
}

/** How the web can show a file from its signed URL. */
export function previewOf(contentType: string): KnowledgeFile['preview'] {
  if (/^image\/(png|jpeg|gif|webp)$/.test(contentType)) return 'image';
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType === 'audio/mpeg' || contentType === 'audio/wav') return 'audio';
  if (contentType === 'video/mp4') return 'video';
  if (/^(text\/(plain|markdown|csv|x-markdown)|application\/(json|x-yaml|yaml|csv))$/.test(contentType)) return 'text';
  return 'none';
}

const recentCursor = (row: { updatedAt: string; id: string }) =>
  Buffer.from(JSON.stringify({ u: row.updatedAt, id: row.id })).toString('base64url');

function decodeRecent(cursor: string | undefined): { u: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { u?: unknown; id?: unknown };
    if (typeof value.u === 'string' && typeof value.id === 'string' && value.id.length <= 64) {
      return { u: value.u, id: value.id };
    }
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid.');
}

export function createKnowledgeService(deps: {
  files: FilesService;
  notifications: NotificationsService;
  hub: Hub;
  /** This server's address: file links with its origin are ours, any other host's are not. */
  publicUrl: string;
}) {
  const presence = createPresence();
  const links = fileLinks(deps.publicUrl);
  /** File links signed for one reader. */
  const signedFor = (markdown: string, memberId: string) =>
    links.sign(markdown, (fileId) => deps.files.signedUrl(fileId, memberId).url);

  const readerFor = (memberId: string, as?: As) => loadReader(memberId, as?.agentId ?? null);

  /** Tells the members who have a doc open. */
  function tell(docId: string, event: RealtimeEvent) {
    const watchers = presence.watchers(docId);
    if (watchers.length) deps.hub.publish(watchers, event);
  }

  const docUpdated = (doc: Pick<DocRow, 'id' | 'version' | 'title' | 'updatedBy' | 'archivedAt'>) =>
    tell(doc.id, {
      type: 'doc.updated',
      data: {
        doc_id: doc.id,
        version: doc.version,
        title: doc.title,
        updated_by: doc.updatedBy,
        archived: !!doc.archivedAt,
      },
    });

  // ── Loading with access ─────────────────────────────────

  async function folderAt(reader: Reader, id: string) {
    const chain = await chainOf(id);
    const folder = chain[0];
    if (!folder) throw notFound('Folder');
    const role = await roleIn(reader, folderSource(folder), chain);
    if (!role) throw notFound('Folder');
    return { folder, chain, role };
  }

  async function docAt(reader: Reader, id: string) {
    const [doc] = await getDb().select().from(docs).where(eq(docs.id, id));
    if (!doc) throw notFound('Doc');
    const chain = await chainOf(doc.folderId);
    const direct =
      doc.space === 'personal' && doc.ownerId !== reader.memberId
        ? ((await docShareRoles(reader, [doc.id])).get(doc.id) ?? null)
        : null;
    const role = await roleIn(reader, docSource(doc), chain, direct);
    if (!role) throw notFound('Doc');
    return { doc, chain, role };
  }

  async function fileAt(reader: Reader, id: string) {
    const [file] = await getDb()
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.purpose, 'knowledge'), eq(files.status, 'active')));
    if (!file) throw notFound('File');
    const docId = typeof file.meta.doc_id === 'string' ? file.meta.doc_id : null;
    if (docId) {
      const owner = await docAt(reader, docId).catch(() => null);
      if (!owner) throw notFound('File');
      return { file, chain: owner.chain, role: owner.role, docId };
    }
    const chain = await chainOf(file.folderId);
    const role = await roleIn(reader, fileSource(file), chain);
    if (!role) throw notFound('File');
    return { file, chain, role, docId };
  }

  function need(role: Role, needed: Role, message: string) {
    if (!atLeast(role, needed)) throw forbidden(message);
  }

  /** Archiving: anyone in the team space, only the owner in a personal one. */
  function needArchive(role: Role, space: KnowledgeSpace) {
    if (space === 'team' ? !atLeast(role, 'editor') : role !== 'owner') {
      throw forbidden('Only its owner can archive or restore it.');
    }
  }

  /** Where something new goes: into a folder the reader may change, or the root of a space. */
  async function placeFor(
    reader: Reader,
    target: { folderId?: string | null; space?: KnowledgeSpace | undefined },
    fallback: KnowledgeSpace = 'personal',
  ): Promise<Place> {
    if (target.folderId) {
      const { folder, chain, role } = await folderAt(reader, target.folderId);
      need(role, 'editor', 'You can read this folder but not change it.');
      if (folder.archivedAt) throw conflict('archived', 'This folder is archived. Restore it first.');
      if (target.space && target.space !== folder.space) throw invalidInput('That folder is in the other space.');
      return { folder, chain, space: folder.space, ownerId: folder.ownerId, agentId: agentOfChain(chain) };
    }
    const space = target.space ?? fallback;
    return { folder: null, chain: [], space, ownerId: space === 'personal' ? reader.memberId : null, agentId: null };
  }

  /** The role on a new item at a place the reader may change: theirs in their own space. */
  const roleAt = (reader: Reader, place: Pick<Place, 'space' | 'ownerId'>): Role =>
    place.space === 'personal' && place.ownerId === reader.memberId ? 'owner' : 'editor';

  /** Personal items go into the team space (their owner's call), never back; never across owners. */
  function checkMove(role: Role, from: { space: KnowledgeSpace; ownerId: string | null }, to: Place) {
    if (from.space === 'team' && to.space === 'personal') {
      throw conflict('cross_space_move', 'Team items stay in the team space.');
    }
    if (from.space === 'personal' && to.space === 'team' && role !== 'owner') {
      throw forbidden('Only its owner can move it into the team space.');
    }
    if (from.space === 'personal' && to.space === 'personal' && from.ownerId !== to.ownerId) {
      throw conflict('cross_space_move', "It can only move within its owner's space.");
    }
  }

  async function hasShares(type: 'folder' | 'doc', ids: readonly string[]): Promise<boolean> {
    if (!ids.length) return false;
    const [row] = await getDb()
      .select({ id: shares.id })
      .from(shares)
      .where(and(eq(shares.resourceType, type), inArray(shares.resourceId, [...ids])))
      .limit(1);
    return !!row;
  }

  async function sharedIds(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await getDb()
      .select({ id: shares.resourceId })
      .from(shares)
      .where(and(inArray(shares.resourceType, ['folder', 'doc']), inArray(shares.resourceId, [...ids])));
    return new Set(rows.map((row) => row.id));
  }

  /** Tree rows with the reader's role on each; rows out of their sight are dropped. */
  async function itemsOf(reader: Reader, sources: Source[]): Promise<KnowledgeItem[]> {
    const [roles, shared] = await Promise.all([
      rolesOf(reader, sources),
      sharedIds(sources.filter((source) => source.type !== 'file').map((source) => source.id)),
    ]);
    return sources.flatMap((source) => {
      const role = roles.get(source.id);
      return role ? [toItem(source, role, shared.has(source.id))] : [];
    });
  }

  /** What is in a folder (or at the root of a space), in tree order. */
  async function contents(
    reader: Reader,
    at: { folderId: string | null; space: KnowledgeSpace; ownerId: string | null },
    archived: boolean,
  ): Promise<KnowledgeItem[]> {
    const live = (column: Parameters<typeof isNull>[0]) => (archived ? undefined : isNull(column));
    const root = (space: SQL, owner: SQL) => and(space, owner);
    const [folderRows, docRows, fileRows] = await Promise.all([
      getDb()
        .select()
        .from(folders)
        .where(
          and(
            at.folderId
              ? eq(folders.parentId, at.folderId)
              : root(
                  and(isNull(folders.parentId), eq(folders.space, at.space))!,
                  at.ownerId ? eq(folders.ownerId, at.ownerId) : isNull(folders.ownerId),
                ),
            live(folders.archivedAt),
          ),
        )
        .limit(MAX_CHILDREN),
      getDb()
        .select(docListColumns)
        .from(docs)
        .where(
          and(
            at.folderId
              ? eq(docs.folderId, at.folderId)
              : root(
                  and(isNull(docs.folderId), eq(docs.space, at.space))!,
                  at.ownerId ? eq(docs.ownerId, at.ownerId) : isNull(docs.ownerId),
                ),
            live(docs.archivedAt),
          ),
        )
        .limit(MAX_CHILDREN),
      getDb()
        .select(fileListColumns)
        .from(files)
        .where(
          and(
            treeFile(),
            at.folderId
              ? eq(files.folderId, at.folderId)
              : root(
                  and(isNull(files.folderId), eq(files.space, at.space))!,
                  at.ownerId ? eq(files.ownerId, at.ownerId) : isNull(files.ownerId),
                ),
            live(files.archivedAt),
          ),
        )
        .limit(MAX_CHILDREN),
    ]);
    const sources = [...folderRows.map(folderSource), ...docRows.map(docSource), ...fileRows.map(fileSource)];
    sources.sort(treeOrder);
    return itemsOf(reader, sources.slice(0, MAX_CHILDREN));
  }

  /** The topmost folders and docs others shared with the reader. */
  async function sharedRoots(reader: Reader): Promise<KnowledgeItem[]> {
    const grants = await getDb()
      .select({ type: shares.resourceType, id: shares.resourceId })
      .from(shares)
      .where(and(inArray(shares.resourceType, ['folder', 'doc']), principalMatch(reader)));
    const folderIds = grants.filter((grant) => grant.type === 'folder').map((grant) => grant.id);
    const docIds = grants.filter((grant) => grant.type === 'doc').map((grant) => grant.id);
    const others = (space: SQL, owner: SQL) => and(space, owner);
    const [reach, folderRows, docRows] = await Promise.all([
      reader.sharedFolders(),
      getDb()
        .select()
        .from(folders)
        .where(
          and(
            inList(folders.id, folderIds),
            isNull(folders.archivedAt),
            others(eq(folders.space, 'personal'), ne(folders.ownerId, reader.memberId)),
          ),
        ),
      getDb()
        .select(docListColumns)
        .from(docs)
        .where(
          and(
            inList(docs.id, docIds),
            isNull(docs.archivedAt),
            others(eq(docs.space, 'personal'), ne(docs.ownerId, reader.memberId)),
          ),
        ),
    ]);
    // Inside another shared folder: reached by opening that one.
    const sources = [
      ...folderRows.filter((row) => !(row.parentId && reach.has(row.parentId))).map(folderSource),
      ...docRows.filter((row) => !(row.folderId && reach.has(row.folderId))).map(docSource),
    ];
    sources.sort(treeOrder);
    return itemsOf(reader, sources);
  }

  /** Each folder's path from the root of its space down to it. */
  async function pathsOf(folderIds: readonly string[]): Promise<Map<string, PathEntry[]>> {
    const wanted = [...new Set(folderIds)];
    if (!wanted.length) return new Map();
    const paths = new Map<string, Array<{ id: string; name: string; depth: number }>>();
    for (const row of await walkUp(wanted)) {
      const list = paths.get(row.start) ?? [];
      list.push({ id: row.id, name: row.name, depth: row.depth });
      paths.set(row.start, list);
    }
    return new Map(
      [...paths].map(([start, list]) => [
        start,
        list.sort((a, b) => b.depth - a.depth).map((entry) => ({ id: entry.id, name: entry.name })),
      ]),
    );
  }

  const pathOf = (chain: readonly FolderRow[]): PathEntry[] =>
    [...chain].reverse().map((folder) => ({ id: folder.id, name: folder.name }));

  /**
   * Whether the reader may see a folder above an item: all of them in the team space and in their
   * own space; in someone else's only the shared ones, so a share never gives away the names of
   * the owner's folders above it.
   */
  async function folderVisible(reader: Reader, item: { space: KnowledgeSpace; ownerId: string | null }) {
    if (item.space === 'team' || item.ownerId === reader.memberId) return () => true;
    const reach = await reader.sharedFolders();
    return (folderId: string) => reach.has(folderId);
  }

  async function visiblePath(
    reader: Reader,
    item: { space: KnowledgeSpace; ownerId: string | null },
    chain: readonly FolderRow[],
  ): Promise<PathEntry[]> {
    const visible = await folderVisible(reader, item);
    return pathOf(chain.filter((folder) => visible(folder.id)));
  }

  // ── Views ────────────────────────────────────────────────

  async function folderView(
    reader: Reader,
    folder: FolderRow,
    chain: FolderRow[],
    role: Role,
  ): Promise<KnowledgeFolder> {
    const [children, names, shared, path] = await Promise.all([
      contents(reader, { folderId: folder.id, space: folder.space, ownerId: folder.ownerId }, !!folder.archivedAt),
      memberNames([folder.createdBy]),
      sharedIds([folder.id]),
      visiblePath(reader, folder, chain.slice(1)),
    ]);
    return {
      ...toItem(folderSource(folder), role, shared.has(folder.id)),
      path,
      children,
      created_by: refOf(names, folder.createdBy),
      created_at: folder.createdAt,
    };
  }

  async function docView(
    reader: Reader,
    doc: DocRow,
    chain: FolderRow[],
    role: Role,
    options: { signed?: boolean } = {},
  ): Promise<KnowledgeDoc> {
    const [[current], names, shared, path] = await Promise.all([
      getDb()
        .select({ agentId: docVersions.agentId })
        .from(docVersions)
        .where(and(eq(docVersions.docId, doc.id), eq(docVersions.version, doc.version))),
      memberNames([doc.createdBy, doc.updatedBy]),
      sharedIds([doc.id]),
      visiblePath(reader, doc, chain),
    ]);
    const writer = current?.agentId ? await agentNames([current.agentId]) : null;
    return {
      id: doc.id,
      title: doc.title,
      content: options.signed === false ? doc.content : signedFor(doc.content, reader.memberId),
      space: doc.space,
      folder_id: doc.folderId,
      owner_id: doc.ownerId,
      path,
      is_template: doc.isTemplate,
      tags: doc.tags,
      meta: doc.meta,
      version: doc.version,
      sort_order: doc.sortOrder,
      access: role,
      shared: shared.has(doc.id),
      agent_id: agentOfChain(chain),
      created_by: refOf(names, doc.createdBy),
      updated_by: refOf(names, doc.updatedBy),
      updated_by_agent:
        current?.agentId && writer ? { id: current.agentId, name: writer.get(current.agentId) ?? '' } : null,
      archived_at: doc.archivedAt,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    };
  }

  function fileView(reader: Reader, file: FileRow, role: Role): KnowledgeFile {
    const link = deps.files.signedUrl(file.id, reader.memberId);
    return {
      ...toItem(fileSource(file), role, false),
      doc_id: typeof file.meta.doc_id === 'string' ? file.meta.doc_id : null,
      preview: previewOf(file.contentType),
      url: link.url,
      expires_at: link.expiresAt,
      created_at: file.createdAt,
    };
  }

  // ── Links and notifications ─────────────────────────────

  /** A doc's outgoing links, rebuilt from its Markdown. */
  async function relink(docId: string, content: string) {
    await getDb().delete(docLinks).where(eq(docLinks.fromDocId, docId));
    const targets = docLinkIds(content).filter((id) => id !== docId);
    if (!targets.length) return;
    const existing = await getDb().select({ id: docs.id }).from(docs).where(inArray(docs.id, targets));
    if (existing.length) {
      await getDb()
        .insert(docLinks)
        .values(existing.map((row) => ({ fromDocId: docId, toDocId: row.id })))
        .onConflictDoNothing();
    }
  }

  /** The reader of a member who may read the doc, else null. */
  async function readerOfDoc(memberId: string, docId: string): Promise<Reader | null> {
    try {
      const reader = await loadReader(memberId);
      await docAt(reader, docId);
      return reader;
    } catch {
      return null;
    }
  }

  /** Who did it: the Agent that wrote for the member, else the member. */
  async function actorName(actor: Reader, agentId: string | null | undefined): Promise<string> {
    if (!agentId) return actor.name;
    return (await agentNames([agentId])).get(agentId) ?? actor.name;
  }

  async function tellMentioned(
    actor: Reader,
    doc: Pick<DocRow, 'id' | 'title' | 'version'>,
    before: string,
    after: string,
    agentId: string | null | undefined,
  ) {
    const earlier = new Set(mentionIds(before));
    const added = mentionIds(after)
      .filter((id) => !earlier.has(id) && id !== actor.memberId)
      .slice(0, MAX_TOLD);
    if (!added.length) return;
    const who = await actorName(actor, agentId);
    for (const memberId of added) {
      const reader = await readerOfDoc(memberId, doc.id);
      if (!reader) continue;
      await deps.notifications.publish({
        memberId,
        kind: 'mention',
        title:
          reader.locale === 'zh' ? `${who} 在《${doc.title}》里提到了你` : `${who} mentioned you in "${doc.title}"`,
        targetType: 'doc',
        targetId: doc.id,
        ...(agentId ? { agentId } : {}),
        payload: { category: 'mention', from_member_id: actor.memberId },
        dedupeKey: `doc:${doc.id}:${doc.version}:mention`,
      });
    }
  }

  async function tellComment(
    actor: Reader,
    doc: DocRow,
    comment: CommentRow,
    previous: readonly string[] | null,
    agentId: string | null | undefined,
  ) {
    const who = await actorName(actor, agentId);
    const body = markdownText(comment.body.slice(0, 1_000)).replace(/\s+/g, ' ').slice(0, 140);
    const earlier = new Set(previous ?? []);
    const mentioned = comment.mentions.filter((id) => !earlier.has(id) && id !== actor.memberId).slice(0, MAX_TOLD);
    for (const memberId of mentioned) {
      const reader = await readerOfDoc(memberId, doc.id);
      if (!reader) continue;
      await deps.notifications.publish({
        memberId,
        kind: 'mention',
        title:
          reader.locale === 'zh'
            ? `${who} 在《${doc.title}》的评论里提到了你`
            : `${who} mentioned you in a comment on "${doc.title}"`,
        body,
        targetType: 'doc',
        targetId: doc.id,
        ...(agentId ? { agentId } : {}),
        payload: { category: 'mention', comment_id: comment.id, from_member_id: actor.memberId },
        dedupeKey: `comment:${comment.id}:mention`,
      });
    }
    // A new comment also tells whoever wrote the doc and commented before.
    if (previous !== null) return;
    const earlierCommenters = await getDb()
      .selectDistinct({ id: comments.createdBy })
      .from(comments)
      .where(
        and(
          eq(comments.targetType, 'doc'),
          eq(comments.targetId, doc.id),
          isNull(comments.deletedAt),
          ne(comments.id, comment.id),
        ),
      )
      .limit(MAX_TOLD);
    const followers = new Set(
      [doc.ownerId ?? doc.createdBy, ...earlierCommenters.map((row) => row.id)].filter((id): id is string => !!id),
    );
    followers.delete(actor.memberId);
    for (const id of mentioned) followers.delete(id);
    for (const memberId of followers) {
      const reader = await readerOfDoc(memberId, doc.id);
      if (!reader) continue;
      await deps.notifications.publish({
        memberId,
        kind: 'comment',
        title: reader.locale === 'zh' ? `${who} 评论了《${doc.title}》` : `${who} commented on "${doc.title}"`,
        body,
        targetType: 'doc',
        targetId: doc.id,
        ...(agentId ? { agentId } : {}),
        payload: { category: 'comment', comment_id: comment.id, from_member_id: actor.memberId },
        dedupeKey: `comment:${comment.id}`,
      });
    }
  }

  // ── Docs ─────────────────────────────────────────────────

  function stale(doc: DocRow): never {
    throw new ApiError(409, 'stale_version', 'Someone saved a newer version. Reload it before saving again.', {
      version: doc.version,
      updated_by: doc.updatedBy,
      updated_at: doc.updatedAt,
    });
  }

  /** Writes a new version of the title and content: a compare-and-set on the version it is based on. */
  async function saveContent(
    reader: Reader,
    doc: DocRow,
    input: {
      version: number;
      title?: string | undefined;
      content?: string | undefined;
      change_note?: string | undefined;
    },
    as: As | undefined,
  ): Promise<DocRow> {
    if (input.version !== doc.version) stale(doc);
    const title = input.title ?? doc.title;
    const content = input.content === undefined ? doc.content : links.canonical(input.content);
    if (title === doc.title && content === doc.content) return doc;
    const [saved] = await getDb()
      .update(docs)
      .set({
        title,
        content,
        version: sql`${docs.version} + 1`,
        updatedBy: reader.memberId,
        updatedAt: sql`now()`,
        ...docSearchColumns({ title, tags: doc.tags, meta: doc.meta, content }),
      })
      .where(and(eq(docs.id, doc.id), eq(docs.version, input.version)))
      .returning();
    if (!saved) {
      const [latest] = await getDb().select().from(docs).where(eq(docs.id, doc.id));
      stale(latest ?? doc);
    }
    await getDb()
      .insert(docVersions)
      .values({
        id: newId('docVersion'),
        docId: saved.id,
        version: saved.version,
        title,
        content,
        changeNote: input.change_note ?? '',
        createdBy: reader.memberId,
        agentId: as?.agentId ?? null,
      });
    if (content !== doc.content) await relink(saved.id, content);
    return saved;
  }

  /** Moves a doc or a file: same space and owner, or a personal one into the team space. */
  async function moveTarget(
    reader: Reader,
    role: Role,
    item: { space: KnowledgeSpace; ownerId: string | null },
    input: { folder_id?: string | null | undefined; space?: KnowledgeSpace | undefined },
  ): Promise<Place | null> {
    if (input.folder_id === undefined && input.space === undefined) return null;
    const place = await placeFor(
      reader,
      { folderId: input.folder_id ?? null, space: input.space },
      input.folder_id === null || input.folder_id === undefined ? item.space : 'personal',
    );
    checkMove(role, item, place);
    return place;
  }

  const service = {
    reader: readerFor,

    /** The root of a space, or the topmost items others shared with the member. */
    async roots(memberId: string, scope: KnowledgeScope, as?: As): Promise<{ items: KnowledgeItem[] }> {
      const reader = await readerFor(memberId, as);
      if (scope === 'shared') return { items: await sharedRoots(reader) };
      return {
        items: await contents(
          reader,
          { folderId: null, space: scope, ownerId: scope === 'personal' ? memberId : null },
          false,
        ),
      };
    },

    async folder(memberId: string, id: string, as?: As): Promise<KnowledgeFolder> {
      const reader = await readerFor(memberId, as);
      const { folder, chain, role } = await folderAt(reader, id);
      return folderView(reader, folder, chain, role);
    },

    async createFolder(memberId: string, input: CreateFolderInput, as?: As): Promise<KnowledgeFolder> {
      const reader = await readerFor(memberId, as);
      const { folder, place } = await transaction(async () => {
        await lockTree('place');
        const place = await placeFor(reader, { folderId: input.folder_id, space: input.space });
        if (place.chain.length + 1 > MAX_FOLDER_DEPTH) throw tooDeep();
        const [folder] = await getDb()
          .insert(folders)
          .values({
            id: newId('folder'),
            parentId: place.folder?.id ?? null,
            space: place.space,
            ownerId: place.ownerId,
            name: input.name,
            createdBy: memberId,
          })
          .returning();
        return { folder: folder!, place };
      });
      return folderView(reader, folder, [folder, ...place.chain], roleAt(reader, place));
    },

    /** Rename or move a folder; moving never goes into itself or below. */
    async updateFolder(memberId: string, id: string, input: UpdateFolderInput): Promise<KnowledgeFolder> {
      const reader = await readerFor(memberId);
      const { folder, role } = await folderAt(reader, id);
      need(role, 'editor', 'You can read this folder but not change it.');
      if (folder.archivedAt) throw conflict('archived', 'This folder is archived. Restore it first.');
      const moving = input.folder_id !== undefined || input.space !== undefined;
      if (moving && folder.agentId) {
        throw conflict('agent_folder', "An Agent's folder stays at the top of its owner's space.");
      }
      await transaction(async () => {
        const changes: Partial<typeof folders.$inferInsert> = {};
        if (input.name !== undefined) changes.name = input.name;
        if (moving) {
          // Folder moves take turns, so two at once cannot close a loop or pass the depth limit
          // the other did not see; the folder and its place are read again under the lock.
          await lockTree('move');
          const { folder, role } = await folderAt(reader, id);
          need(role, 'editor', 'You can read this folder but not change it.');
          if (folder.archivedAt) throw conflict('archived', 'This folder is archived. Restore it first.');
          const place = await placeFor(
            reader,
            { folderId: input.folder_id ?? null, space: input.space },
            input.folder_id === null || input.folder_id === undefined ? folder.space : 'personal',
          );
          checkMove(role, folder, place);
          if (place.chain.some((above) => above.id === folder.id)) {
            throw conflict('folder_cycle', 'A folder cannot move into itself or below it.');
          }
          const below = await walkDown([folder.id]);
          const height = 1 + below.reduce((deepest, row) => Math.max(deepest, row.depth), 0);
          if (place.chain.length + height > MAX_FOLDER_DEPTH) throw tooDeep();
          const inside = below.map((row) => row.id);
          if (place.agentId) {
            const docIds = (await getDb().select({ id: docs.id }).from(docs).where(inList(docs.folderId, inside))).map(
              (row) => row.id,
            );
            if ((await hasShares('folder', inside)) || (await hasShares('doc', docIds))) {
              throw conflict('agent_folder_private', "An Agent's folder is private: stop sharing what you move first.");
            }
          }
          changes.parentId = place.folder?.id ?? null;
          if (place.space !== folder.space) {
            // Into the team space: everything inside goes along and belongs to everyone.
            const docIds = (await getDb().select({ id: docs.id }).from(docs).where(inList(docs.folderId, inside))).map(
              (row) => row.id,
            );
            await getDb()
              .update(folders)
              .set({ space: 'team', ownerId: null, updatedAt: sql`now()` })
              .where(inList(folders.id, inside));
            await getDb()
              .update(docs)
              .set({ space: 'team', ownerId: null, updatedAt: sql`now()` })
              .where(inList(docs.folderId, inside));
            await getDb()
              .update(files)
              .set({ space: 'team', ownerId: null, updatedAt: sql`now()` })
              .where(and(eq(files.purpose, 'knowledge'), inList(files.folderId, inside)));
            await getDb()
              .delete(shares)
              .where(
                or(
                  and(eq(shares.resourceType, 'folder'), inList(shares.resourceId, inside)),
                  and(eq(shares.resourceType, 'doc'), inList(shares.resourceId, docIds)),
                ),
              );
          }
        }
        if (Object.keys(changes).length) {
          await getDb()
            .update(folders)
            .set({ ...changes, updatedAt: sql`now()` })
            .where(eq(folders.id, folder.id));
        }
      });
      return service.folder(memberId, id);
    },

    /** Archives a folder with everything in it, all stamped with the same time. */
    async archiveFolder(memberId: string, id: string): Promise<void> {
      const reader = await readerFor(memberId);
      const { folder, role } = await folderAt(reader, id);
      needArchive(role, folder.space);
      if (folder.archivedAt) return;
      const stamp = new Date().toISOString();
      const archivedDocs = await transaction(async () => {
        const inside = await subtree([folder.id]);
        await getDb()
          .update(folders)
          .set({ archivedAt: stamp })
          .where(and(inList(folders.id, inside), isNull(folders.archivedAt)));
        await getDb()
          .update(files)
          .set({ archivedAt: stamp })
          .where(and(eq(files.purpose, 'knowledge'), inList(files.folderId, inside), isNull(files.archivedAt)));
        return getDb()
          .update(docs)
          .set({ archivedAt: stamp })
          .where(and(inList(docs.folderId, inside), isNull(docs.archivedAt)))
          .returning();
      });
      for (const doc of archivedDocs) docUpdated(doc);
    },

    /** Brings back exactly what was archived with the folder; to the root when its parent stays archived. */
    async restoreFolder(memberId: string, id: string): Promise<KnowledgeFolder> {
      const reader = await readerFor(memberId);
      const { folder, chain, role } = await folderAt(reader, id);
      needArchive(role, folder.space);
      if (!folder.archivedAt) return folderView(reader, folder, chain, role);
      const stamp = folder.archivedAt;
      const restoredDocs = await transaction(async () => {
        const inside = await subtree([folder.id]);
        const parentArchived = !!chain[1]?.archivedAt;
        await getDb()
          .update(folders)
          .set({ archivedAt: null, ...(parentArchived ? { parentId: null } : {}), updatedAt: sql`now()` })
          .where(eq(folders.id, folder.id));
        await getDb()
          .update(folders)
          .set({ archivedAt: null })
          .where(and(inList(folders.id, inside), eq(folders.archivedAt, stamp)));
        await getDb()
          .update(files)
          .set({ archivedAt: null })
          .where(and(eq(files.purpose, 'knowledge'), inList(files.folderId, inside), eq(files.archivedAt, stamp)));
        return getDb()
          .update(docs)
          .set({ archivedAt: null })
          .where(and(inList(docs.folderId, inside), eq(docs.archivedAt, stamp)))
          .returning();
      });
      for (const doc of restoredDocs) docUpdated(doc);
      return service.folder(memberId, id);
    },

    /** Puts some items of one folder (or a space root) in this order. */
    async reorder(memberId: string, input: ReorderInput): Promise<void> {
      const reader = await readerFor(memberId);
      let space: KnowledgeSpace;
      let ownerId: string | null;
      if (input.folder_id) {
        const { folder, role } = await folderAt(reader, input.folder_id);
        need(role, 'editor', 'You can read this folder but not change it.');
        space = folder.space;
        ownerId = folder.ownerId;
      } else {
        if (!input.space) throw invalidInput('Say which space, for its root.');
        space = input.space;
        ownerId = space === 'personal' ? memberId : null;
      }
      const inPlace = <T extends { folder: string | null; space: string | null; owner: string | null }>(row: T) =>
        row.folder === input.folder_id && row.space === space && row.owner === ownerId;
      const ids = (type: 'folder' | 'doc' | 'file') =>
        input.items.filter((item) => item.type === type).map((item) => item.id);
      await transaction(async () => {
        const [folderRows, docRows, fileRows] = await Promise.all([
          getDb()
            .select({ id: folders.id, folder: folders.parentId, space: folders.space, owner: folders.ownerId })
            .from(folders)
            .where(inList(folders.id, ids('folder'))),
          getDb()
            .select({ id: docs.id, folder: docs.folderId, space: docs.space, owner: docs.ownerId })
            .from(docs)
            .where(inList(docs.id, ids('doc'))),
          getDb()
            .select({
              id: files.id,
              folder: files.folderId,
              space: files.space,
              owner: files.ownerId,
              meta: files.meta,
            })
            .from(files)
            .where(and(treeFile(), inList(files.id, ids('file')))),
        ]);
        const found = [...folderRows, ...docRows, ...fileRows].filter(inPlace).length;
        if (found !== new Set(input.items.map((item) => `${item.type}:${item.id}`)).size) {
          throw invalidInput('Some items are not in that folder.');
        }
        for (const [index, item] of input.items.entries()) {
          const order = index + 1;
          if (item.type === 'folder') {
            await getDb().update(folders).set({ sortOrder: order }).where(eq(folders.id, item.id));
          } else if (item.type === 'doc') {
            await getDb().update(docs).set({ sortOrder: order }).where(eq(docs.id, item.id));
          } else {
            const meta = fileRows.find((row) => row.id === item.id)?.meta ?? {};
            await getDb()
              .update(files)
              .set({ meta: { ...meta, sort_order: order } })
              .where(eq(files.id, item.id));
          }
        }
      });
    },

    /** What was archived in a space, topmost first; an archived folder opens to the rest. */
    async archived(memberId: string, space: KnowledgeSpace): Promise<{ items: KnowledgeItem[] }> {
      const reader = await readerFor(memberId);
      const ownerId = space === 'personal' ? memberId : null;
      const owned = (column: Parameters<typeof eq>[0]) => (ownerId ? eq(column, ownerId) : isNull(column));
      const [folderRows, docRows, fileRows] = await Promise.all([
        getDb()
          .select()
          .from(folders)
          .where(and(eq(folders.space, space), owned(folders.ownerId), sql`${folders.archivedAt} IS NOT NULL`)),
        getDb()
          .select(docListColumns)
          .from(docs)
          .where(and(eq(docs.space, space), owned(docs.ownerId), sql`${docs.archivedAt} IS NOT NULL`)),
        getDb()
          .select(fileListColumns)
          .from(files)
          .where(and(treeFile(), eq(files.space, space), owned(files.ownerId), sql`${files.archivedAt} IS NOT NULL`)),
      ]);
      const stamps = new Map(folderRows.map((row) => [row.id, row.archivedAt]));
      // Archived together with the folder above: reached by opening it.
      const topmost = (parent: string | null, stamp: string | null) => !parent || stamps.get(parent) !== stamp;
      const sources = [
        ...folderRows.filter((row) => topmost(row.parentId, row.archivedAt)).map(folderSource),
        ...docRows.filter((row) => topmost(row.folderId, row.archivedAt)).map(docSource),
        ...fileRows.filter((row) => topmost(row.folderId, row.archivedAt)).map(fileSource),
      ].sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '') || treeOrder(a, b));
      return { items: await itemsOf(reader, sources.slice(0, MAX_CHILDREN)) };
    },

    /** Recently updated docs the member may read, newest first; templates with `template`. */
    async listDocs(
      memberId: string,
      query: {
        space?: KnowledgeScope | undefined;
        template?: 'true' | 'false' | undefined;
        cursor?: string;
        limit: number;
      },
      as?: As,
    ): Promise<Page<KnowledgeItem>> {
      const reader = await readerFor(memberId, as);
      const after = decodeRecent(query.cursor);
      const scope =
        query.space === 'team'
          ? eq(docs.space, 'team')
          : query.space === 'personal'
            ? and(eq(docs.space, 'personal'), eq(docs.ownerId, memberId))
            : query.space === 'shared'
              ? and(eq(docs.space, 'personal'), ne(docs.ownerId, memberId))
              : undefined;
      const rows = await getDb()
        .select(docListColumns)
        .from(docs)
        .where(
          and(
            isNull(docs.archivedAt),
            await readableWhere(reader, docs, 'doc'),
            scope,
            query.template ? eq(docs.isTemplate, query.template === 'true') : undefined,
            after
              ? or(lt(docs.updatedAt, after.u), and(eq(docs.updatedAt, after.u), lt(docs.id, after.id)))
              : undefined,
          ),
        )
        .orderBy(desc(docs.updatedAt), desc(docs.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items = await itemsOf(reader, page.map(docSource));
      return { items, next_cursor: rows.length > query.limit ? recentCursor(page[page.length - 1]!) : null };
    },

    async createDoc(memberId: string, input: CreateDocInput, as?: As): Promise<KnowledgeDoc> {
      const reader = await readerFor(memberId, as);
      let template: DocRow | null = null;
      if (input.template_id) {
        const found = await docAt(reader, input.template_id);
        if (!found.doc.isTemplate) throw invalidInput('That doc is not a template.');
        template = found.doc;
      }
      const title = input.title ?? template!.title;
      const content = links.canonical(input.content ?? template?.content ?? '');
      const tags = input.tags ?? template?.tags ?? [];
      const meta = input.meta ?? {};
      const { doc, place } = await transaction(async () => {
        // Where it goes is read under the tree lock: a folder moving into the team space meanwhile
        // takes the new doc along, or the new doc lands where the folder is now.
        await lockTree('place');
        const place = await placeFor(reader, { folderId: input.folder_id, space: input.space });
        const [row] = await getDb()
          .insert(docs)
          .values({
            id: newId('doc'),
            folderId: place.folder?.id ?? null,
            space: place.space,
            ownerId: place.ownerId,
            title,
            content,
            isTemplate: input.is_template ?? false,
            tags,
            meta,
            version: 1,
            ...docSearchColumns({ title, tags, meta, content }),
            createdBy: memberId,
            updatedBy: memberId,
          })
          .returning();
        await getDb()
          .insert(docVersions)
          .values({
            id: newId('docVersion'),
            docId: row!.id,
            version: 1,
            title,
            content,
            changeNote: input.change_note ?? '',
            createdBy: memberId,
            agentId: as?.agentId ?? null,
          });
        await relink(row!.id, content);
        return { doc: row!, place };
      });
      await tellMentioned(reader, doc, '', content, as?.agentId);
      return docView(reader, doc, place.chain, roleAt(reader, place));
    },

    /** The doc; its file links signed for the member unless `signed` is false (what a model reads). */
    async getDoc(memberId: string, id: string, options: { as?: As; signed?: boolean } = {}): Promise<KnowledgeDoc> {
      const reader = await readerFor(memberId, options.as);
      const { doc, chain, role } = await docAt(reader, id);
      return docView(reader, doc, chain, role, { signed: options.signed ?? true });
    },

    /**
     * Saves a doc. A new title or content needs the version it is based on and adds a version;
     * tags, meta and the template flag change in place; a folder or space moves it.
     */
    async updateDoc(memberId: string, id: string, input: UpdateDocInput, as?: As): Promise<KnowledgeDoc> {
      const reader = await readerFor(memberId, as);
      const { doc, role } = await docAt(reader, id);
      need(role, 'editor', 'You can read this doc but not change it.');
      if (doc.archivedAt) throw conflict('archived', 'This doc is archived. Restore it first.');
      const before = doc.content;
      const moving = input.folder_id !== undefined || input.space !== undefined;
      const saved = await transaction(async () => {
        let current = { doc, role };
        if (moving) {
          // Moves take the tree lock alone; the doc and where it goes are read again under it.
          await lockTree('move');
          current = await docAt(reader, id);
          need(current.role, 'editor', 'You can read this doc but not change it.');
          if (current.doc.archivedAt) throw conflict('archived', 'This doc is archived. Restore it first.');
        }
        let row = current.doc;
        if (input.title !== undefined || input.content !== undefined) {
          row = await saveContent(reader, row, { ...input, version: input.version! }, as);
        }
        const changes: Partial<typeof docs.$inferInsert> = {};
        if (input.is_template !== undefined) changes.isTemplate = input.is_template;
        if (input.tags !== undefined) changes.tags = input.tags;
        if (input.meta !== undefined) changes.meta = input.meta;
        if (input.tags !== undefined || input.meta !== undefined) {
          Object.assign(
            changes,
            docSearchColumns({
              title: row.title,
              tags: input.tags ?? row.tags,
              meta: input.meta ?? row.meta,
              content: row.content,
            }),
          );
        }
        const place = await moveTarget(reader, current.role, current.doc, input);
        if (place) {
          if (place.agentId && (await hasShares('doc', [doc.id]))) {
            throw conflict('agent_folder_private', "An Agent's folder is private: stop sharing this doc first.");
          }
          changes.folderId = place.folder?.id ?? null;
          changes.space = place.space;
          changes.ownerId = place.ownerId;
          if (place.space === 'team' && current.doc.space === 'personal') {
            await getDb()
              .delete(shares)
              .where(and(eq(shares.resourceType, 'doc'), eq(shares.resourceId, doc.id)));
          }
        }
        if (Object.keys(changes).length) {
          const [updated] = await getDb()
            .update(docs)
            .set({ ...changes, updatedBy: memberId, updatedAt: sql`now()` })
            .where(eq(docs.id, doc.id))
            .returning();
          row = updated!;
        }
        return row;
      });
      await tellMentioned(reader, saved, before, saved.content, as?.agentId);
      if (saved.version !== doc.version || saved.updatedAt !== doc.updatedAt) docUpdated(saved);
      return service.getDoc(memberId, id, { as: as ?? {} });
    },

    async archiveDoc(memberId: string, id: string): Promise<void> {
      const reader = await readerFor(memberId);
      const { doc, role } = await docAt(reader, id);
      needArchive(role, doc.space);
      if (doc.archivedAt) return;
      const [archived] = await getDb()
        .update(docs)
        .set({ archivedAt: sql`now()` })
        .where(eq(docs.id, id))
        .returning();
      docUpdated(archived!);
    },

    /** Back where it was; to the root of its space when its folder is archived. */
    async restoreDoc(memberId: string, id: string): Promise<KnowledgeDoc> {
      const reader = await readerFor(memberId);
      const { doc, chain, role } = await docAt(reader, id);
      needArchive(role, doc.space);
      if (doc.archivedAt) {
        const [restored] = await getDb()
          .update(docs)
          .set({ archivedAt: null, ...(chain[0]?.archivedAt ? { folderId: null } : {}) })
          .where(eq(docs.id, id))
          .returning();
        docUpdated(restored!);
      }
      return service.getDoc(memberId, id);
    },

    async versions(memberId: string, id: string, query: { cursor?: string; limit: number }): Promise<Page<DocVersion>> {
      const reader = await readerFor(memberId);
      await docAt(reader, id);
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select({
          id: docVersions.id,
          version: docVersions.version,
          title: docVersions.title,
          changeNote: docVersions.changeNote,
          createdBy: docVersions.createdBy,
          agentId: docVersions.agentId,
          createdAt: docVersions.createdAt,
        })
        .from(docVersions)
        .where(and(eq(docVersions.docId, id), before ? lt(docVersions.id, before) : undefined))
        .orderBy(desc(docVersions.id))
        .limit(query.limit + 1);
      const [people, writers] = await Promise.all([
        memberNames(rows.map((row) => row.createdBy)),
        agentNames(rows.map((row) => row.agentId)),
      ]);
      return toPage(rows, query.limit, (row) => ({
        version: row.version,
        title: row.title,
        change_note: row.changeNote,
        created_by: refOf(people, row.createdBy),
        agent: row.agentId ? { id: row.agentId, name: writers.get(row.agentId) ?? '' } : null,
        created_at: row.createdAt,
      }));
    },

    async version(memberId: string, id: string, version: number): Promise<DocVersionDetail> {
      const reader = await readerFor(memberId);
      await docAt(reader, id);
      const [row] = await getDb()
        .select()
        .from(docVersions)
        .where(and(eq(docVersions.docId, id), eq(docVersions.version, version)));
      if (!row) throw notFound('Version');
      const [people, writers] = await Promise.all([memberNames([row.createdBy]), agentNames([row.agentId])]);
      return {
        version: row.version,
        title: row.title,
        change_note: row.changeNote,
        created_by: refOf(people, row.createdBy),
        agent: row.agentId ? { id: row.agentId, name: writers.get(row.agentId) ?? '' } : null,
        created_at: row.createdAt,
        content: signedFor(row.content, memberId),
      };
    },

    /** Writes a new version with an old one's title and content. */
    async restoreVersion(memberId: string, id: string, version: number, current: number, as?: As) {
      const reader = await readerFor(memberId, as);
      const [row] = await getDb()
        .select()
        .from(docVersions)
        .where(and(eq(docVersions.docId, id), eq(docVersions.version, version)));
      await docAt(reader, id);
      if (!row) throw notFound('Version');
      return service.updateDoc(
        memberId,
        id,
        {
          version: current,
          title: row.title,
          content: row.content,
          change_note: reader.locale === 'zh' ? `恢复到版本 ${version}` : `Restored version ${version}`,
        },
        as,
      );
    },

    async diff(
      memberId: string,
      id: string,
      query: { from?: number | undefined; to?: number | undefined; mode: 'line' | 'word' },
    ): Promise<DocDiff> {
      const reader = await readerFor(memberId);
      const { doc } = await docAt(reader, id);
      const to = query.to ?? doc.version;
      const from = query.from ?? Math.max(1, to - 1);
      const rows = await getDb()
        .select()
        .from(docVersions)
        .where(and(eq(docVersions.docId, id), inArray(docVersions.version, [from, to])));
      const older = rows.find((row) => row.version === from);
      const newer = rows.find((row) => row.version === to);
      if (!older || !newer) throw notFound('Version');
      const result = diffText(older.content, newer.content, query.mode);
      return {
        from,
        to,
        mode: query.mode,
        title: older.title === newer.title ? null : { from: older.title, to: newer.title },
        ...result,
      };
    },

    /** Docs that link here, as far as the member may read them. */
    async backlinks(memberId: string, id: string, as?: As): Promise<{ items: KnowledgeItem[] }> {
      const reader = await readerFor(memberId, as);
      await docAt(reader, id);
      const rows = await getDb()
        .select(docListColumns)
        .from(docLinks)
        .innerJoin(docs, eq(docs.id, docLinks.fromDocId))
        .where(and(eq(docLinks.toDocId, id), isNull(docs.archivedAt), await readableWhere(reader, docs, 'doc')))
        .orderBy(desc(docs.updatedAt))
        .limit(MAX_CHILDREN);
      return { items: await itemsOf(reader, rows.map(docSource)) };
    },

    // ── Comments ─────────────────────────────────────────

    async comments(
      memberId: string,
      docId: string,
      query: { cursor?: string; limit: number },
    ): Promise<Page<KnowledgeComment>> {
      const reader = await readerFor(memberId);
      await docAt(reader, docId);
      const after = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.targetType, 'doc'),
            eq(comments.targetId, docId),
            isNull(comments.deletedAt),
            after ? gt(comments.id, after) : undefined,
          ),
        )
        .orderBy(asc(comments.id))
        .limit(query.limit + 1);
      const view = await commentViews(memberId, rows);
      return toPage(rows, query.limit, (row) => view(row));
    },

    /** Anyone who reads a doc may comment on it; mentions and the doc's people are told. */
    async addComment(memberId: string, docId: string, body: string, as?: As): Promise<KnowledgeComment> {
      const reader = await readerFor(memberId, as);
      const { doc } = await docAt(reader, docId);
      if (doc.archivedAt) throw conflict('archived', 'This doc is archived. Restore it first.');
      const [row] = await getDb()
        .insert(comments)
        .values({
          id: newId('comment'),
          targetType: 'doc',
          targetId: docId,
          createdBy: memberId,
          agentId: as?.agentId ?? null,
          body: links.canonical(body),
          mentions: mentionIds(body),
        })
        .returning();
      await tellComment(reader, doc, row!, null, as?.agentId);
      tell(docId, { type: 'comments.updated', data: { target_type: 'doc', target_id: docId, comment_id: row!.id } });
      return (await commentViews(memberId, [row!]))(row!);
    },

    async editComment(memberId: string, docId: string, commentId: string, body: string): Promise<KnowledgeComment> {
      const reader = await readerFor(memberId);
      const { doc } = await docAt(reader, docId);
      const own = await ownComment(memberId, docId, commentId);
      const [row] = await getDb()
        .update(comments)
        .set({ body: links.canonical(body), mentions: mentionIds(body), updatedAt: new Date().toISOString() })
        .where(eq(comments.id, own.id))
        .returning();
      await tellComment(reader, doc, row!, own.mentions, own.agentId);
      tell(docId, { type: 'comments.updated', data: { target_type: 'doc', target_id: docId, comment_id: row!.id } });
      return (await commentViews(memberId, [row!]))(row!);
    },

    async removeComment(memberId: string, docId: string, commentId: string): Promise<void> {
      const reader = await readerFor(memberId);
      await docAt(reader, docId);
      const own = await ownComment(memberId, docId, commentId);
      await getDb()
        .update(comments)
        .set({ deletedAt: sql`now()` })
        .where(eq(comments.id, own.id));
      tell(docId, { type: 'comments.updated', data: { target_type: 'doc', target_id: docId, comment_id: own.id } });
    },

    // ── Shares ───────────────────────────────────────────

    /** Its own shares, and what it gets from the folders above it. */
    async shares(memberId: string, type: 'folder' | 'doc', id: string): Promise<KnowledgeShares> {
      const reader = await readerFor(memberId);
      const found = type === 'folder' ? await folderAt(reader, id) : await docAt(reader, id);
      const item = 'folder' in found ? found.folder : found.doc;
      // Only from the folders above it that the reader may see themselves.
      const visible = await folderVisible(reader, item);
      const above = (type === 'folder' ? found.chain.slice(1) : found.chain).filter((folder) => visible(folder.id));
      const rows = await getDb()
        .select()
        .from(shares)
        .where(
          or(
            and(eq(shares.resourceType, type), eq(shares.resourceId, id)),
            and(
              eq(shares.resourceType, 'folder'),
              inList(
                shares.resourceId,
                above.map((folder) => folder.id),
              ),
            ),
          ),
        )
        .orderBy(asc(shares.createdAt), asc(shares.id));
      const own = rows.filter((row) => row.resourceType === type && row.resourceId === id);
      const inherited = rows.filter((row) => !own.includes(row));
      const [ownViews, inheritedViews] = await Promise.all([shareViews(own), shareViews(inherited)]);
      const names = new Map(above.map((folder) => [folder.id, folder.name]));
      return {
        items: ownViews,
        inherited: inheritedViews.map((view, index) => ({
          ...view,
          folder_id: inherited[index]!.resourceId,
          folder_name: names.get(inherited[index]!.resourceId) ?? '',
        })),
      };
    },

    /** Replaces an item's own shares. Only the owner of a personal item shares it. */
    async share(memberId: string, type: 'folder' | 'doc', id: string, input: ShareInput): Promise<KnowledgeShares> {
      const reader = await readerFor(memberId);
      const shareable = async () => {
        const found = type === 'folder' ? await folderAt(reader, id) : await docAt(reader, id);
        const item = type === 'folder' ? (found as { folder: FolderRow }).folder : (found as { doc: DocRow }).doc;
        if (item.space === 'team') throw conflict('team_space', 'Everyone already reads and changes the team space.');
        if (found.role !== 'owner') throw forbidden('Only its owner can share it.');
        if (agentOfChain(found.chain)) {
          throw conflict('agent_folder_private', "An Agent's folder is private to the Agent and its owner.");
        }
        if (item.archivedAt) throw conflict('archived', 'Restore it before sharing it.');
        return item;
      };
      const item = await shareable();
      // One entry per member, group or the workspace; the last one wins.
      const wanted = new Map<string, { type: 'member' | 'group' | 'workspace'; id: string | null; role: string }>();
      for (const entry of input.items) {
        if (entry.type === 'member' && entry.id === memberId) continue;
        wanted.set(`${entry.type}:${entry.id ?? ''}`, { type: entry.type, id: entry.id ?? null, role: entry.role });
      }
      const memberIds = [...wanted.values()].filter((entry) => entry.type === 'member').map((entry) => entry.id!);
      const groupIds = [...wanted.values()].filter((entry) => entry.type === 'group').map((entry) => entry.id!);
      const [people, teams] = await Promise.all([
        getDb()
          .select({ id: members.id })
          .from(members)
          .where(and(inList(members.id, memberIds), ne(members.status, 'disabled'))),
        getDb().select({ id: groups.id }).from(groups).where(inList(groups.id, groupIds)),
      ]);
      if (people.length !== memberIds.length || teams.length !== groupIds.length) {
        throw invalidInput('Some members or groups do not exist.');
      }
      const added = await transaction(async () => {
        // Checked again under the tree lock: a move into an Agent's folder or the team space
        // cannot slip in between the check and the shares.
        await lockTree('place');
        await shareable();
        const existing = await getDb()
          .select()
          .from(shares)
          .where(and(eq(shares.resourceType, type), eq(shares.resourceId, id)));
        const keyOf = (row: { principalType: string; principalId: string | null }) =>
          `${row.principalType}:${row.principalId ?? ''}`;
        const gone = existing.filter((row) => !wanted.has(keyOf(row)));
        if (gone.length) {
          await getDb()
            .delete(shares)
            .where(
              inArray(
                shares.id,
                gone.map((row) => row.id),
              ),
            );
        }
        const fresh: Array<{ id: string; type: string; principal: string | null }> = [];
        for (const [key, entry] of wanted) {
          const before = existing.find((row) => keyOf(row) === key);
          if (before) {
            if (before.role !== entry.role) {
              await getDb().update(shares).set({ role: entry.role }).where(eq(shares.id, before.id));
            }
            continue;
          }
          const shareId = newId('share');
          await getDb().insert(shares).values({
            id: shareId,
            resourceType: type,
            resourceId: id,
            principalType: entry.type,
            principalId: entry.id,
            role: entry.role,
            createdBy: memberId,
          });
          fresh.push({ id: shareId, type: entry.type, principal: entry.id });
        }
        return fresh;
      });
      await tellShared(reader, type, id, type === 'folder' ? (item as FolderRow).name : (item as DocRow).title, added);
      return service.shares(memberId, type, id);
    },

    // ── Presence ─────────────────────────────────────────

    async presence(memberId: string, docId: string): Promise<{ items: DocPresence[] }> {
      const reader = await readerFor(memberId);
      await docAt(reader, docId);
      return { items: presence.list(docId) };
    },

    /**
     * A heartbeat from an open doc; editing needs the right to change it. Someone who may no
     * longer read it leaves the list at once, so live updates stop reaching them.
     */
    async beat(memberId: string, docId: string, state: PresenceState): Promise<{ items: DocPresence[] }> {
      let found: { reader: Reader; role: Role };
      try {
        const reader = await readerFor(memberId);
        found = { reader, role: (await docAt(reader, docId)).role };
      } catch (error) {
        service.leave(memberId, docId);
        throw error;
      }
      if (state === 'editing') need(found.role, 'editor', 'You can read this doc but not change it.');
      const { items, changed } = presence.beat(docId, { id: memberId, name: found.reader.name }, state);
      if (changed) tell(docId, { type: 'doc.presence', data: { doc_id: docId, items } });
      return { items };
    },

    /** I closed it. Only someone who had it open changes the list, and only those left are told. */
    leave(memberId: string, docId: string): void {
      const { items, left } = presence.leave(docId, memberId);
      if (left) tell(docId, { type: 'doc.presence', data: { doc_id: docId, items } });
    },

    // ── Files ────────────────────────────────────────────

    /** Into a folder or a space root, or for a doc (a picture pasted into it: it follows the doc). */
    async upload(
      memberId: string,
      input: {
        name: string;
        contentType: string;
        bytes: Uint8Array;
        folderId?: string | undefined;
        space?: KnowledgeSpace | undefined;
        docId?: string | undefined;
      },
    ): Promise<KnowledgeFile> {
      const reader = await readerFor(memberId);
      const meta: Record<string, unknown> = { uploaded_by: memberId, ...(input.docId ? { doc_id: input.docId } : {}) };
      /** Where the file goes, and the uploader's role there. */
      const placeNow = async (): Promise<{
        place: { folderId: string | null; space: KnowledgeSpace; ownerId: string | null };
        role: Role;
      }> => {
        if (input.docId) {
          const found = await docAt(reader, input.docId);
          need(found.role, 'editor', 'You can read this doc but not change it.');
          if (found.doc.archivedAt) throw conflict('archived', 'This doc is archived. Restore it first.');
          return {
            place: { folderId: found.doc.folderId, space: found.doc.space, ownerId: found.doc.ownerId },
            role: found.role,
          };
        }
        const target = await placeFor(reader, { folderId: input.folderId, space: input.space });
        return {
          place: { folderId: target.folder?.id ?? null, space: target.space, ownerId: target.ownerId },
          role: roleAt(reader, target),
        };
      };
      const first = await placeNow();
      const stored = await deps.files.store(memberId, {
        name: input.name,
        contentType: input.contentType,
        bytes: input.bytes,
        purpose: 'knowledge',
        ...first.place,
        meta,
      });
      let role: Role;
      try {
        // The bytes are stored outside the tree lock; where the file sits is settled under it, so
        // a folder that moved into the team space meanwhile takes the new file along.
        role = await transaction(async () => {
          await lockTree('place');
          const now = await placeNow();
          await getDb().update(files).set(now.place).where(eq(files.id, stored.id));
          return now.role;
        });
      } catch (error) {
        await deps.files.discard(stored.id);
        throw error;
      }
      if (!input.docId) {
        // The name and the text inside go into search.
        let text: string | null = null;
        try {
          text = await fileText({ contentType: stored.content_type, name: stored.name }, input.bytes);
        } catch (error) {
          logger.warn('[knowledge] could not read an uploaded file', { file: stored.id, error: toErrorMessage(error) });
        }
        const excerpt = text?.replace(/\s+/g, ' ').trim().slice(0, 300);
        await getDb()
          .update(files)
          .set({
            searchA: searchTokens(stored.name),
            searchC: searchTokens(text?.slice(0, MAX_FILE_TEXT)),
            ...(excerpt ? { meta: { ...meta, excerpt } } : {}),
          })
          .where(eq(files.id, stored.id));
      }
      const [row] = await getDb().select().from(files).where(eq(files.id, stored.id));
      return fileView(reader, row!, role);
    },

    async file(memberId: string, id: string): Promise<KnowledgeFile> {
      const reader = await readerFor(memberId);
      const { file, role } = await fileAt(reader, id);
      return fileView(reader, file, role);
    },

    async updateFile(memberId: string, id: string, input: UpdateFileInput): Promise<KnowledgeFile> {
      const reader = await readerFor(memberId);
      const moving = input.folder_id !== undefined || input.space !== undefined;
      const check = async () => {
        const found = await fileAt(reader, id);
        need(found.role, 'editor', 'You can read this file but not change it.');
        if (found.file.archivedAt) throw conflict('archived', 'This file is archived. Restore it first.');
        if (moving && found.docId) throw conflict('doc_file', 'This file belongs to a doc and moves with it.');
        return found;
      };
      await check();
      await transaction(async () => {
        // Moves take the tree lock alone; the file and where it goes are read again under it.
        if (moving) await lockTree('move');
        const { file, role, docId } = moving ? await check() : await fileAt(reader, id);
        const changes: Partial<typeof files.$inferInsert> = {};
        if (input.name !== undefined) {
          changes.name = input.name;
          if (!docId) changes.searchA = searchTokens(input.name);
        }
        const place = moving
          ? await moveTarget(reader, role, { space: file.space ?? 'team', ownerId: file.ownerId }, input)
          : null;
        if (place) {
          changes.folderId = place.folder?.id ?? null;
          changes.space = place.space;
          changes.ownerId = place.ownerId;
        }
        if (Object.keys(changes).length) {
          await getDb()
            .update(files)
            .set({ ...changes, updatedAt: sql`now()` })
            .where(eq(files.id, id));
        }
      });
      return service.file(memberId, id);
    },

    async archiveFile(memberId: string, id: string): Promise<void> {
      const reader = await readerFor(memberId);
      const { file, role, docId } = await fileAt(reader, id);
      if (docId) throw conflict('doc_file', 'This file belongs to a doc: take it out of the doc instead.');
      needArchive(role, file.space ?? 'team');
      if (!file.archivedAt)
        await getDb()
          .update(files)
          .set({ archivedAt: sql`now()` })
          .where(eq(files.id, id));
    },

    async restoreFile(memberId: string, id: string): Promise<KnowledgeFile> {
      const reader = await readerFor(memberId);
      const { file, chain, role } = await fileAt(reader, id);
      needArchive(role, file.space ?? 'team');
      if (file.archivedAt) {
        await getDb()
          .update(files)
          .set({ archivedAt: null, ...(chain[0]?.archivedAt ? { folderId: null } : {}) })
          .where(eq(files.id, id));
      }
      return service.file(memberId, id);
    },

    /** The read check the file service asks for knowledge files (signed URLs, downloads). */
    async canReadFile(memberId: string, row: FileRow): Promise<boolean> {
      try {
        await fileAt(await loadReader(memberId), row.id);
        return true;
      } catch {
        return false;
      }
    },

    // ── Export ───────────────────────────────────────────

    async exportDoc(memberId: string, id: string): Promise<{ filename: string; markdown: string }> {
      const reader = await readerFor(memberId);
      const { doc } = await docAt(reader, id);
      const heading = /^#\s+(.+)$/m.exec(doc.content.trimStart().split('\n')[0] ?? '')?.[1]?.trim();
      const markdown = heading === doc.title.trim() ? doc.content : `# ${doc.title}\n\n${doc.content}`;
      return {
        filename: exportFilename(doc.title, 'doc'),
        markdown: markdown.endsWith('\n') ? markdown : `${markdown}\n`,
      };
    },

    /** A folder, or a whole space (`space` with a null id), as a ZIP written while it downloads. */
    async exportTree(
      memberId: string,
      root: { folderId: string } | { space: KnowledgeSpace },
    ): Promise<{ filename: string; body: ReadableStream<Uint8Array> }> {
      const reader = await readerFor(memberId);
      const copy = exportCopy(reader.locale);
      let label: string;
      let rootId: string | null;
      let folderRows: FolderRow[];
      if ('folderId' in root) {
        const { folder } = await folderAt(reader, root.folderId);
        const inside = await subtree([folder.id]);
        label = folder.name;
        rootId = folder.id;
        folderRows = await getDb()
          .select()
          .from(folders)
          .where(and(inList(folders.id, inside), folder.archivedAt ? undefined : isNull(folders.archivedAt)));
      } else {
        label =
          root.space === 'team'
            ? reader.locale === 'zh'
              ? '团队知识库'
              : 'Team knowledge'
            : reader.locale === 'zh'
              ? '我的知识库'
              : 'My knowledge';
        rootId = null;
        folderRows = await getDb()
          .select()
          .from(folders)
          .where(
            and(
              eq(folders.space, root.space),
              root.space === 'personal' ? eq(folders.ownerId, memberId) : isNull(folders.ownerId),
              isNull(folders.archivedAt),
            ),
          );
      }
      const folderIds = folderRows.map((row) => row.id);
      const inSpace = (table: typeof docs | typeof files) =>
        'space' in root
          ? and(
              isNull(table.folderId),
              eq(table.space, root.space),
              root.space === 'personal' ? eq(table.ownerId, memberId) : isNull(table.ownerId),
            )
          : undefined;
      const archivedToo = 'folderId' in root && folderRows.some((row) => row.id === rootId && row.archivedAt);
      const [docRows, fileRows] = await Promise.all([
        getDb()
          .select({
            id: docs.id,
            folderId: docs.folderId,
            title: docs.title,
            content: docs.content,
            version: docs.version,
            updatedAt: docs.updatedAt,
          })
          .from(docs)
          .where(
            and(or(inList(docs.folderId, folderIds), inSpace(docs)), archivedToo ? undefined : isNull(docs.archivedAt)),
          )
          .orderBy(asc(docs.id)),
        getDb()
          .select({ id: files.id, folderId: files.folderId, name: files.name, sizeBytes: files.sizeBytes })
          .from(files)
          .where(
            and(
              treeFile(),
              or(inList(files.folderId, folderIds), inSpace(files)),
              archivedToo ? undefined : isNull(files.archivedAt),
            ),
          )
          .orderBy(asc(files.id)),
      ]);
      // Pictures and files the docs show, when the member may open them.
      const inTree = new Set(fileRows.map((row) => row.id));
      const shown = [...new Set(docRows.flatMap((doc) => links.ids(doc.content)))].filter((id) => !inTree.has(id));
      const assets: ExportFile[] = [];
      for (const id of shown) {
        const row = await deps.files.get(memberId, id).catch(() => null);
        if (row) assets.push({ id: row.id, folderId: null, name: row.name, sizeBytes: row.sizeBytes });
      }
      const exportedAt = new Date().toISOString();
      const plan = planExport({
        rootId,
        folders: folderRows.map((row) => ({ id: row.id, parentId: row.parentId, name: row.name })),
        docs: docRows,
        files: fileRows,
        assets,
        locale: reader.locale,
        label,
        exportedAt,
        links,
      });
      const body = zipStream(async (zip) => {
        for (const entry of plan.entries) {
          if ('text' in entry) {
            await zip.text(entry.path, entry.text);
            continue;
          }
          const content = await deps.files.content(memberId, entry.fileId).catch(() => null);
          if (!content) plan.notes.push(copy.missing(entry.path));
          else await zip.stream(entry.path, content.body);
        }
        const notes = notesEntry(reader.locale, plan.notes);
        if (notes && 'text' in notes) await zip.text(notes.path, notes.text);
      });
      return { filename: `${safeSegment(label, 'knowledge')}-${exportedAt.slice(0, 10)}.zip`, body };
    },

    // ── Search ───────────────────────────────────────────

    /**
     * Full text over titles, summaries and bodies of what the member may read (docs, and files by
     * name and text), Chinese and English, best first. Every word must match first; if that finds
     * too little, any word may; a plain substring search is the last resort.
     */
    async search(
      memberId: string,
      query: { q: string; space?: KnowledgeScope | undefined; folder_id?: string | undefined; limit: number },
      as?: As,
    ): Promise<{ items: KnowledgeSearchHit[] }> {
      const reader = await readerFor(memberId, as);
      const words = queryWords(query.q);
      let within: string[] | null = null;
      if (query.folder_id) {
        await folderAt(reader, query.folder_id);
        within = await subtree([query.folder_id]);
      }
      const scopeOf = (table: typeof docs | typeof files) =>
        query.space === 'team'
          ? eq(table.space, 'team')
          : query.space === 'personal'
            ? and(eq(table.space, 'personal'), eq(table.ownerId, memberId))
            : query.space === 'shared'
              ? and(eq(table.space, 'personal'), ne(table.ownerId, memberId))
              : undefined;
      const [docReadable, fileReadable] = await Promise.all([
        readableWhere(reader, docs, 'doc'),
        readableWhere(reader, files, 'file'),
      ]);
      const docWhere = and(
        isNull(docs.archivedAt),
        docReadable,
        scopeOf(docs),
        within ? inList(docs.folderId, within) : undefined,
      );
      const fileWhere = and(
        treeFile(),
        isNull(files.archivedAt),
        fileReadable,
        scopeOf(files),
        within ? inList(files.folderId, within) : undefined,
      );

      type Hit = Omit<KnowledgeSearchHit, 'path'>;
      const hits = new Map<string, Hit>();
      /** Whose space each hit is in, to show only the folders above it the reader may see. */
      const owners = new Map<string, string | null>();
      const take = (hit: Hit) => {
        if (!hits.has(hit.id)) hits.set(hit.id, hit);
      };
      const docHit = (row: {
        id: string;
        title: string;
        content: string;
        space: KnowledgeSpace;
        folderId: string | null;
        ownerId: string | null;
        updatedAt: string;
        score: number;
      }): Hit => {
        owners.set(row.id, row.ownerId);
        return {
          type: 'doc',
          id: row.id,
          title: row.title,
          snippet: docSnippet(row.content, words),
          space: row.space,
          folder_id: row.folderId,
          score: Number(row.score),
          updated_at: row.updatedAt,
        };
      };
      const fileHit = (row: {
        id: string;
        name: string;
        space: KnowledgeSpace | null;
        folderId: string | null;
        ownerId: string | null;
        meta: Record<string, unknown>;
        updatedAt: string;
        score: number;
      }): Hit => {
        owners.set(row.id, row.ownerId);
        return {
          type: 'file',
          id: row.id,
          title: row.name,
          snippet: typeof row.meta.excerpt === 'string' ? snippetFor(row.meta.excerpt, words) : '',
          space: row.space ?? 'team',
          folder_id: row.folderId,
          score: Number(row.score),
          updated_at: row.updatedAt,
        };
      };

      for (const op of ['&', '|'] as const) {
        const tsquery = searchQuery(query.q, op);
        if (!tsquery || hits.size >= query.limit) continue;
        const parsed = sql`to_tsquery('simple', ${tsquery})`;
        const docRank = sql<number>`ts_rank(${docs.searchTsv}, ${parsed})`;
        const fileRank = sql<number>`ts_rank(${files.searchTsv}, ${parsed})`;
        const [docRows, fileRows] = await Promise.all([
          getDb()
            .select({
              id: docs.id,
              title: docs.title,
              content: docs.content,
              space: docs.space,
              folderId: docs.folderId,
              ownerId: docs.ownerId,
              updatedAt: docs.updatedAt,
              score: docRank,
            })
            .from(docs)
            .where(and(sql`${docs.searchTsv} @@ ${parsed}`, docWhere))
            .orderBy(desc(docRank), desc(docs.updatedAt))
            .limit(query.limit),
          getDb()
            .select({
              id: files.id,
              name: files.name,
              space: files.space,
              folderId: files.folderId,
              ownerId: files.ownerId,
              meta: files.meta,
              updatedAt: files.updatedAt,
              score: fileRank,
            })
            .from(files)
            .where(and(sql`${files.searchTsv} @@ ${parsed}`, fileWhere))
            .orderBy(desc(fileRank), desc(files.updatedAt))
            .limit(query.limit),
        ]);
        const round = [...docRows.map(docHit), ...fileRows.map(fileHit)].sort(
          (a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at),
        );
        for (const hit of round) take(hit);
      }
      if (!hits.size) {
        // Part of a word (say "64" in "LPH64"): what the index cannot see.
        const like = containing(query.q);
        const [docRows, fileRows] = await Promise.all([
          getDb()
            .select({
              id: docs.id,
              title: docs.title,
              content: docs.content,
              space: docs.space,
              folderId: docs.folderId,
              ownerId: docs.ownerId,
              updatedAt: docs.updatedAt,
              score: sql<number>`0`,
            })
            .from(docs)
            .where(and(or(ilike(docs.title, like), ilike(docs.content, like)), docWhere))
            .orderBy(desc(docs.updatedAt))
            .limit(query.limit),
          getDb()
            .select({
              id: files.id,
              name: files.name,
              space: files.space,
              folderId: files.folderId,
              ownerId: files.ownerId,
              meta: files.meta,
              updatedAt: files.updatedAt,
              score: sql<number>`0`,
            })
            .from(files)
            .where(and(ilike(files.name, like), fileWhere))
            .orderBy(desc(files.updatedAt))
            .limit(query.limit),
        ]);
        for (const hit of [...docRows.map(docHit), ...fileRows.map(fileHit)]) take(hit);
      }
      const ranked = [...hits.values()].slice(0, query.limit);
      const [paths, reach] = await Promise.all([
        pathsOf(ranked.flatMap((hit) => (hit.folder_id ? [hit.folder_id] : []))),
        reader.sharedFolders(),
      ]);
      return {
        items: ranked.map((hit) => {
          const path = hit.folder_id ? (paths.get(hit.folder_id) ?? []) : [];
          const all = hit.space === 'team' || owners.get(hit.id) === memberId;
          return { ...hit, path: all ? path : path.filter((entry) => reach.has(entry.id)) };
        }),
      };
    },

    // ── An Agent's private reference folder ─────────────

    /** The Agent's folder in its owner's space; made on first use when `create`. */
    async agentFolder(agent: Pick<Agent, 'id' | 'ownerId' | 'name'>, create: boolean): Promise<FolderRow | null> {
      const find = async () => {
        const [row] = await getDb().select().from(folders).where(eq(folders.agentId, agent.id));
        return row ?? null;
      };
      const existing = await find();
      if (existing || !create) return existing;
      await getDb()
        .insert(folders)
        .values({
          id: newId('folder'),
          space: 'personal',
          ownerId: agent.ownerId,
          agentId: agent.id,
          name: agent.name,
          createdBy: agent.ownerId,
        })
        .onConflictDoNothing();
      return find();
    },

    /** Whether an item sits in this Agent's own private folder (writes there need no approval). */
    async inAgentFolder(type: 'folder' | 'doc', id: string, agentId: string): Promise<boolean> {
      let folderId: string | null = id;
      if (type === 'doc') {
        const [doc] = await getDb().select({ folderId: docs.folderId }).from(docs).where(eq(docs.id, id));
        folderId = doc?.folderId ?? null;
      }
      return agentOfChain(await chainOf(folderId)) === agentId;
    },
  };

  /** Comments as the reader sees them: with names, and file links signed for them. */
  async function commentViews(memberId: string, rows: CommentRow[]) {
    const [people, writers] = await Promise.all([
      memberNames(rows.map((row) => row.createdBy)),
      agentNames(rows.map((row) => row.agentId)),
    ]);
    return (row: CommentRow): KnowledgeComment => ({
      id: row.id,
      target_type: row.targetType,
      target_id: row.targetId,
      body: signedFor(row.body, memberId),
      mentions: row.mentions,
      created_by: refOf(people, row.createdBy),
      agent: row.agentId ? { id: row.agentId, name: writers.get(row.agentId) ?? '' } : null,
      mine: row.createdBy === memberId,
      edited: Date.parse(row.updatedAt) > Date.parse(row.createdAt),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  async function ownComment(memberId: string, docId: string, commentId: string): Promise<CommentRow> {
    const [row] = await getDb()
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.id, commentId),
          eq(comments.targetType, 'doc'),
          eq(comments.targetId, docId),
          isNull(comments.deletedAt),
        ),
      );
    if (!row) throw notFound('Comment');
    if (row.createdBy !== memberId) throw forbidden('Only who wrote a comment can change it.');
    return row;
  }

  /** Tells the members a new share reaches (group members too; not the whole workspace). */
  async function tellShared(
    actor: Reader,
    type: 'folder' | 'doc',
    id: string,
    name: string,
    added: ReadonlyArray<{ id: string; type: string; principal: string | null }>,
  ) {
    for (const share of added) {
      let memberIds: string[] = [];
      if (share.type === 'member' && share.principal) memberIds = [share.principal];
      if (share.type === 'group' && share.principal) {
        memberIds = (
          await getDb()
            .select({ id: groupMembers.memberId })
            .from(groupMembers)
            .where(eq(groupMembers.groupId, share.principal))
            .limit(200)
        ).map((row) => row.id);
      }
      for (const memberId of memberIds) {
        if (memberId === actor.memberId) continue;
        const reader = await loadReader(memberId).catch(() => null);
        if (!reader) continue;
        await deps.notifications.publish({
          memberId,
          kind: 'share',
          title:
            reader.locale === 'zh'
              ? `${actor.name} 把《${name}》分享给了你`
              : `${actor.name} shared "${name}" with you`,
          targetType: type,
          targetId: id,
          payload: { category: 'share', from_member_id: actor.memberId },
          dedupeKey: `share:${share.id}`,
        });
      }
    }
  }

  // The file service asks this module who may read knowledge files.
  deps.files.govern('knowledge', (memberId, row) => service.canReadFile(memberId, row));

  return service;
}

export type KnowledgeService = ReturnType<typeof createKnowledgeService>;
