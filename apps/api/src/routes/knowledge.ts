/**
 * Knowledge routes — /api/knowledge (team + personal docs)
 *
 * GET    /api/knowledge/docs                          — 文档列表（默认：团队 + 本人个人文档）
 * POST   /api/knowledge/docs                          — 创建文档（body 可含 folder_id 直接入目录）
 * GET    /api/knowledge/docs/id/:id                   — 按数字 id 获取文档详情（规范深链解析）
 * GET    /api/knowledge/docs/:slug                    — 按 slug 获取文档详情
 * PUT    /api/knowledge/docs/:id                      — 更新文档并记录版本（body 可含 folder_id 移动目录）
 * DELETE /api/knowledge/docs/:id                      — 归档文档（软删除）
 * GET    /api/knowledge/docs/:id/versions             — 获取文档版本历史
 * POST   /api/knowledge/docs/:id/versions/:v/restore  — 回滚到指定版本（记录为新版本）
 * POST   /api/knowledge/docs/generate                 — AI 生成文档草稿
 * POST   /api/knowledge/docs/:id/ai/rewrite           — AI 改写当前文档
 * POST   /api/knowledge/docs/:id/enrich               — AI 生成 summary/questions/topics/tags
 * GET    /api/knowledge/search                        — 搜索团队知识库
 * GET    /api/knowledge/docs/:id/shares               — 私有文档的共享列表
 * POST   /api/knowledge/docs/:id/shares               — 添加/更新共享（user/group, reader/editor）
 * DELETE /api/knowledge/docs/:id/shares/:target       — 撤销共享
 * GET    /api/knowledge/docs/templates                — team 可见模板列表（从模板新建）
 * GET    /api/knowledge/docs/:id/backlinks            — 反链（按调用者读权限过滤）
 * GET    /api/knowledge/docs/:id/comments             — 文档评论（读权限跟随文档）
 * POST   /api/knowledge/docs/:id/comments             — 新增评论（触发 WeCom 通知）
 * DELETE /api/knowledge/comments/:cid                 — 删除评论（作者或 super，软删）
 * POST   /api/knowledge/docs/:id/editing-presence     — 编辑心跳，返回其他在编辑者
 * POST   /api/knowledge/tree/reorder                  — 侧栏树同级手动排序（只写顺序，不移动）
 * GET    /api/knowledge/export                        — 整库导出为 Markdown zip（仅 super）
 *
 * 隔离规则：个人文档（visibility='private'）按 owner_user_id 隔离 —— 列表只返回
 * 调用者本人的个人文档，单文档读取/修改/归档/回滚都校验归属；团队文档
 * （visibility='team'）对全体内部用户协作可见可改。与 agent 知识工具一致。
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { KnowledgeDocRow, KnowledgeDocVersionRow, KnowledgeShareRole } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { markdownToTiptapJson } from '@greenhouse/knowledge-editor/markdown';
import { getAuthUser, requireSuper } from '../auth/middleware.js';
import { contentDisposition } from '../http/content-disposition.js';
import { buildKnowledgeExport } from '../knowledge/export.js';
import { resolveDriveAccess, canWriteDrive } from '../drive/access.js';
import { nowIso } from '@greenhouse/utils/date';
import { checkPromptInjection, sanitizeForPrompt } from '../security/security.js';
import { completeJson } from '../llm/complete.js';
import { resolveKbAccess, canRead, canWrite, canArchive, canManageSharing } from '../knowledge/access.js';
import { notifyKbComment } from '../knowledge/notify.js';
import { KNOWLEDGE_SEARCH_SCOPES, searchKnowledgeScopes, type KnowledgeSearchScope } from '../knowledge/search.js';
import { touchEditingPresence, listEditingPresence } from '../knowledge/presence.js';
import type { AppEnv } from '../app-env.js';
import { knowledgePlatformHttpMiddleware } from '../platform/knowledge/http-adapter.js';

type Visibility = 'team' | 'private';
type Status = 'draft' | 'published' | 'archived';

interface KnowledgeAiResult {
  title: string;
  slug: string;
  content_markdown: string;
  summary: string;
  questions: string[];
  topics: string[];
  tags: string[];
}

interface KnowledgeRewriteResult {
  title?: string;
  content_markdown: string;
  change_summary: string;
}

interface KnowledgeEnrichResult {
  summary: string;
  questions: string[];
  topics: string[];
  tags: string[];
}

function slugify(input: string): string {
  const ascii = input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
  return ascii || `doc-${Date.now()}`;
}

function normalizeVisibility(value: unknown): Visibility {
  return value === 'private' ? 'private' : 'team';
}

function normalizeStatus(value: unknown): Status {
  return value === 'draft' || value === 'archived' ? value : 'published';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v).trim())
    .filter(Boolean)
    .slice(0, 20);
}

function docToApi(row: KnowledgeDocRow) {
  const meta = safeJsonParse(row.meta || '{}', {}) as Record<string, unknown>;
  return {
    id: row.id,
    slug: row.doc_id,
    title: row.title,
    content_markdown: row.content,
    content_json: row.content_json || '{}',
    summary: row._summary || '',
    questions: row._questions || '[]',
    topics: row._topics || '[]',
    tags: row.tags || '[]',
    space: typeof meta.space === 'string' ? meta.space : 'general',
    folder_id: row.folder_id,
    sort_order: row.sort_order,
    is_template: row.is_template,
    visibility: normalizeVisibility(row.visibility),
    status: normalizeStatus(row.status),
    owner_user_id: row.owner_user_id,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function versionToApi(row: KnowledgeDocVersionRow) {
  return {
    id: row.id,
    doc_id: row.doc_id,
    version: row.version,
    title: row.title,
    content_markdown: row.content,
    content_json: row.content_json || '{}',
    summary: row.summary || '',
    changed_by: row.changed_by,
    change_reason: row.change_reason,
    created_at: row.created_at,
  };
}

function normalizeRole(value: unknown): KnowledgeShareRole {
  return value === 'editor' ? 'editor' : 'reader';
}

/** A share target is a user_id, or 'group:<id>' for a whole group. */
function groupTarget(groupId: number): string {
  return `group:${groupId}`;
}

function buildMeta(space: unknown, meta: unknown): Record<string, unknown> {
  const base =
    typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  base.space = typeof space === 'string' && space.trim() ? space.trim() : (base.space as string) || 'general';
  return base;
}

/** Serialize a doc with the caller's effective access role, so the UI can gate controls. */
async function docToApiWithAccess(row: KnowledgeDocRow, userId: string) {
  const access = await resolveKbAccess(getDb(), row, userId);
  return { ...docToApi(row), access };
}

// ─── Sharing helpers (private docs) ──────────────────────

type OwnedDoc = { ok: true; doc: KnowledgeDocRow } | { ok: false; status: 404 | 403; error: string };

/** Resolve the doc + assert the caller owns it (only owners manage sharing). */
async function resolveOwnedDoc(userId: string, id: number): Promise<OwnedDoc> {
  const doc = await getDb().knowledgeBase.getById(id);
  if (!doc) return { ok: false, status: 404, error: 'Document not found' };
  const access = await resolveKbAccess(getDb(), doc, userId);
  if (!canManageSharing(access)) return { ok: false, status: 403, error: 'Only the owner can manage sharing' };
  return { ok: true, doc };
}

/**
 * Resolve a user's display nickname. The access token carries only uid/role, so
 * `AuthUser.nickname` is normally undefined — look it up rather than falling back
 * to the raw UUID in comment authorship / presence banners.
 */
async function nicknameOf(userId: string, hint?: string): Promise<string> {
  if (hint) return hint;
  const u = await getDb()
    .users.getById(userId)
    .catch(() => undefined);
  return u?.nickname ?? userId;
}

/**
 * Validate a folder move target for a doc. `null` = move to root (always ok).
 * The target must be an existing scope='kb' folder whose access domain matches
 * the doc: a team doc goes in a team folder; a private doc goes only in the
 * owner's own private folder. Returns an error string, or null when allowed.
 */
async function validateFolderTarget(
  folderId: number | null,
  docVisibility: Visibility,
  docOwnerId: string | null,
): Promise<string | null> {
  if (folderId == null) return null;
  const folder = await getDb().drive.getFolder(folderId);
  if (!folder || folder.scope !== 'kb') return 'Target folder not found';
  if (docVisibility === 'team') {
    if (folder.visibility !== 'team') return 'Team docs can only move into a team folder';
  } else {
    if (folder.visibility !== 'private' || folder.owner_user_id !== docOwnerId) {
      return 'Private docs can only move into your own folder';
    }
  }
  return null;
}

const knowledgeRoutes = new Hono<AppEnv>()
  .use('*', knowledgePlatformHttpMiddleware())

  // ─── Sidebar tree ordering ──────────────────────────────
  //
  // Placement (which folder) keeps going through the existing PUT endpoints —
  // they already own the cross-scope / cycle / ownership checks. This one only
  // writes sibling order, and refuses anything that isn't already a sibling, so
  // it can never become a second way to move a node.
  .post('/tree/reorder', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = body.kind === 'folder' || body.kind === 'doc' ? body.kind : null;
    if (!kind) return c.json({ error: 'kind must be "doc" or "folder"' }, 400);

    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (ids.length === 0) return c.json({ error: 'ids is required' }, 400);
    if (ids.length !== new Set(ids).size) return c.json({ error: 'ids must be unique' }, 400);
    if (ids.length > 500) return c.json({ error: 'too many ids' }, 400);

    const parentId = body.parent_id == null ? null : Number(body.parent_id);
    if (parentId !== null && !Number.isInteger(parentId)) return c.json({ error: 'invalid parent_id' }, 400);

    const db = getDb();
    if (kind === 'doc') {
      const docs = await db.knowledgeBase.listByIds(ids);
      if (docs.length !== ids.length) return c.json({ error: 'document not found' }, 404);
      // One ordered group = one folder AND one access domain. At the root both
      // team docs and someone's private docs live side by side, and they render
      // in different trees — ordering across them is meaningless, not merely odd.
      const domain = `${docs[0].visibility}:${docs[0].owner_user_id ?? ''}`;
      for (const doc of docs) {
        if ((doc.folder_id ?? null) !== parentId) return c.json({ error: 'documents are not siblings' }, 400);
        if (`${doc.visibility}:${doc.owner_user_id ?? ''}` !== domain) {
          return c.json({ error: 'documents span different scopes' }, 400);
        }
        if (!canWrite(await resolveKbAccess(db, doc, user.id))) return c.json({ error: 'document not found' }, 404);
      }
      await db.knowledgeBase.reorderDocs(ids);
      return c.json({ ok: true });
    }

    const folders = await Promise.all(ids.map((id) => db.drive.getFolder(id)));
    const rows = folders.filter((f): f is NonNullable<typeof f> => !!f);
    if (rows.length !== ids.length) return c.json({ error: 'folder not found' }, 404);
    const domain = `${rows[0].visibility}:${rows[0].owner_user_id ?? ''}`;
    for (const folder of rows) {
      if (folder.scope !== 'kb') return c.json({ error: 'folder not found' }, 404);
      if ((folder.parent_id ?? null) !== parentId) return c.json({ error: 'folders are not siblings' }, 400);
      if (`${folder.visibility}:${folder.owner_user_id ?? ''}` !== domain) {
        return c.json({ error: 'folders span different scopes' }, 400);
      }
      if (!canWriteDrive(resolveDriveAccess(folder, user.id, {}))) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    await db.drive.reorderFolders(ids);
    return c.json({ ok: true });
  })

  // ─── Whole-library export (super only) ──────────────────
  //
  // The guard is on the bare path: Hono's `/*` does not match `/export` itself,
  // so `.use('/export/*')` would leave this wide open to any internal user.
  .use('/export', requireSuper())
  .get('/export', async (c) => {
    // Optional scope narrows the download; it never widens what may be packed
    // (the team-visibility filter inside applies to all three shapes).
    const folderId = Number(c.req.query('folder_id'));
    const docId = Number(c.req.query('doc_id'));
    const result = await buildKnowledgeExport(getDb(), nowIso(), {
      folderId: Number.isInteger(folderId) && folderId > 0 ? folderId : undefined,
      docId: Number.isInteger(docId) && docId > 0 ? docId : undefined,
    });
    logger.info('[knowledge] exported library', { by: getAuthUser(c).id, ...result.stats, notes: undefined });
    // Copy into an ArrayBuffer-backed view: fflate's Uint8Array is typed over
    // ArrayBufferLike, which Hono's body type does not accept.
    return c.body(new Uint8Array(result.bytes), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(result.filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  })

  // ─── CRUD ───────────────────────────────────────────────

  .get('/docs', async (c) => {
    const user = getAuthUser(c);
    const search = c.req.query('search') || undefined;
    const space = c.req.query('space') || undefined;
    const status = normalizeStatus(c.req.query('status'));
    const visibility = c.req.query('visibility'); // 'team' | 'private' | 'shared' | undefined
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10), 0);
    const base = { scope: 'shared', status, space, search, limit, offset } as const;
    const db = getDb();

    // Private docs that OTHER people shared with the caller (directly or via a group).
    const sharedWithMe = async (): Promise<KnowledgeDocRow[]> => {
      const ids = await db.knowledgeShares.listDocIdsForUser(user.id);
      if (ids.length === 0) return [];
      const docs = await db.knowledgeBase.listByIds(ids, { status });
      // listByIds is not owner-scoped; keep only private docs the caller does NOT own
      // (own docs already come from the private branch) and apply the space filter.
      return docs.filter(
        (d) =>
          d.visibility === 'private' &&
          d.owner_user_id !== user.id &&
          (!space || (safeJsonParse(d.meta || '{}', {}) as any).space === space),
      );
    };

    let rows: KnowledgeDocRow[];
    if (visibility === 'team') {
      rows = await db.knowledgeBase.list({ ...base, visibility: 'team' });
    } else if (visibility === 'private') {
      // Personal scope: strictly the caller's own private docs.
      rows = await db.knowledgeBase.list({ ...base, visibility: 'private', ownerUserId: user.id });
    } else if (visibility === 'shared') {
      // Only docs others shared with the caller.
      rows = await sharedWithMe();
    } else {
      // Default: team + the caller's own private + private docs shared with the caller.
      const [team, mine, shared] = await Promise.all([
        db.knowledgeBase.list({ ...base, visibility: 'team' }),
        db.knowledgeBase.list({ ...base, visibility: 'private', ownerUserId: user.id }),
        sharedWithMe(),
      ]);
      rows = [...team, ...mine, ...shared];
    }
    return c.json({ docs: await Promise.all(rows.map((r) => docToApiWithAccess(r, user.id))) });
  })
  .post('/docs', async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const title = String(body.title || '').trim();
    if (!title) return c.json({ error: 'title is required' }, 400);

    const content = String(body.content_markdown ?? body.content ?? '');
    const explicitSlug = String(body.slug || body.doc_id || '').trim();
    const slug = slugify(explicitSlug || title);
    const existing = await getDb().knowledgeBase.get(slug, 'shared');
    if (existing) return c.json({ error: 'slug already exists', slug }, 409);

    // Optional folder placement, so "new doc in this folder" from the sidebar tree
    // is one request instead of create-then-move.
    const visibility = normalizeVisibility(body.visibility);
    let folderId: number | null = null;
    if (body.folder_id !== undefined && body.folder_id !== null) {
      folderId = parseInt(String(body.folder_id), 10);
      if (!Number.isFinite(folderId)) return c.json({ error: 'Invalid folder_id' }, 400);
      const err = await validateFolderTarget(folderId, visibility, user.id);
      if (err) return c.json({ error: err }, 400);
    }

    const row = await getDb().knowledgeBase.create({
      doc_id: slug,
      scope: 'shared',
      title,
      content,
      content_json:
        typeof body.content_json === 'string'
          ? body.content_json
          : body.content_json !== undefined
            ? JSON.stringify(body.content_json)
            : markdownToTiptapJson(content),
      visibility,
      status: normalizeStatus(body.status),
      is_template: body.is_template === true,
      folder_id: folderId,
      tags: normalizeStringArray(body.tags),
      meta: buildMeta(body.space, body.meta),
      owner_user_id: user.id,
      created_by: user.id,
      updated_by: user.id,
      _summary: String(body.summary || ''),
      _questions: normalizeStringArray(body.questions),
      _topics: normalizeStringArray(body.topics),
    });
    await getDb().knowledgeBase.rebuildOutlinks(row.id, content);
    return c.json({ doc: docToApi(row) }, 201);
  })
  .get('/docs/templates', async (c) => {
    // Team-visible templates for "new from template". Static segment — must be
    // registered before /docs/:slug so it isn't captured as a slug.
    const rows = await getDb().knowledgeBase.listTemplates();
    return c.json({ templates: rows.map((r) => ({ id: r.id, slug: r.doc_id, title: r.title })) });
  })
  .get('/docs/id/:id', async (c) => {
    // Canonical id-based read backing the stable `#/knowledge/doc/<id>-<slug>` deeplink
    // (id is authoritative; slug can be renamed). The `id/` static segment can't
    // collide with `/docs/:slug` (single segment) or `/docs/:id/versions`.
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const doc = await getDb().knowledgeBase.getById(id);
    if (!doc || doc.status === 'archived') return c.json({ error: 'Document not found' }, 404);
    const access = await resolveKbAccess(getDb(), doc, user.id);
    if (!canRead(access)) return c.json({ error: 'Document not found' }, 404);
    return c.json({ doc: { ...docToApi(doc), access } });
  })
  .get('/docs/:slug', async (c) => {
    const user = getAuthUser(c);
    // Hono already URL-decodes path params — a second decode would corrupt slugs containing '%'
    const slug = c.req.param('slug');
    const doc = await getDb().knowledgeBase.get(slug, 'shared');
    if (!doc || doc.status === 'archived') return c.json({ error: 'Document not found' }, 404);
    const access = await resolveKbAccess(getDb(), doc, user.id);
    if (!canRead(access)) return c.json({ error: 'Document not found' }, 404);
    return c.json({ doc: { ...docToApi(doc), access } });
  })
  .put('/docs/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await getDb().knowledgeBase.getById(id);
    if (!existing) return c.json({ error: 'Document not found' }, 404);
    const access = await resolveKbAccess(getDb(), existing, user.id);
    if (!canWrite(access)) return c.json({ error: 'Document not found' }, 404);

    const body = await c.req.json().catch(() => ({}));

    const updates: Record<string, unknown> = {};
    if (body.slug !== undefined || body.doc_id !== undefined) {
      // Only normalize a slug the caller actually changed. The editor echoes the
      // doc's current slug back on every save, and other writers create doc_ids
      // holding characters slugify rewrites (the brand import namespaces with
      // '/'), so normalizing unconditionally renamed docs on plain content edits.
      const requested = String(body.slug ?? body.doc_id);
      if (requested !== existing.doc_id) updates.doc_id = slugify(requested);
    }
    if (body.title !== undefined) updates.title = String(body.title).trim();
    const contentChanged = body.content_markdown !== undefined || body.content !== undefined;
    if (contentChanged) {
      updates.content = String(body.content_markdown ?? body.content ?? '');
    }
    if (body.content_json !== undefined) {
      updates.content_json =
        typeof body.content_json === 'string' ? body.content_json : JSON.stringify(body.content_json ?? {});
    } else if (contentChanged) {
      // Markdown changed without fresh editor JSON — derive it so the two stay in sync.
      updates.content_json = markdownToTiptapJson(updates.content as string);
    }
    if (body.visibility !== undefined) {
      // Changing visibility (e.g. publishing a private doc to the whole team, or
      // locking it back down) is an ownership-level action.
      const next = normalizeVisibility(body.visibility);
      if (next !== existing.visibility && !canManageSharing(access)) {
        return c.json({ error: 'Only the owner can change visibility' }, 403);
      }
      updates.visibility = next;
    }
    if (body.status !== undefined) updates.status = normalizeStatus(body.status);
    if (body.is_template !== undefined) updates.is_template = body.is_template === true;
    if (body.tags !== undefined) updates.tags = normalizeStringArray(body.tags);
    if (body.space !== undefined || body.meta !== undefined) updates.meta = buildMeta(body.space, body.meta);
    if (body.folder_id !== undefined) {
      const folderId = body.folder_id === null ? null : parseInt(String(body.folder_id), 10);
      if (folderId !== null && !Number.isFinite(folderId)) return c.json({ error: 'Invalid folder_id' }, 400);
      // Validate against the doc's resulting visibility/owner (either may change in this PUT).
      const nextVisibility = (updates.visibility as Visibility) ?? normalizeVisibility(existing.visibility);
      const err = await validateFolderTarget(folderId, nextVisibility, existing.owner_user_id);
      if (err) return c.json({ error: err }, 400);
      updates.folder_id = folderId;
    }
    if (body.summary !== undefined) updates._summary = String(body.summary || '');
    if (body.questions !== undefined) updates._questions = normalizeStringArray(body.questions);
    if (body.topics !== undefined) updates._topics = normalizeStringArray(body.topics);

    // Last-write-wins conflict detection (D2): if the client sent the
    // base_updated_at it loaded and the row moved on since, we still save (LWW)
    // but flag it so the UI can offer a diff against the other person's version.
    let conflicted: { conflicted: true; updated_by: string | null; updated_at: string | null } | undefined;
    if (
      typeof body.base_updated_at === 'string' &&
      existing.updated_at &&
      body.base_updated_at !== existing.updated_at
    ) {
      conflicted = { conflicted: true, updated_by: existing.updated_by, updated_at: existing.updated_at };
    }

    const doc = await getDb().knowledgeBase.update(
      id,
      updates as any,
      user.id,
      String(body.change_reason || 'Updated from editor'),
    );
    if (!doc) return c.json({ error: 'Document not found' }, 404);
    if (contentChanged) await getDb().knowledgeBase.rebuildOutlinks(doc.id, doc.content);
    return c.json({ doc: { ...docToApi(doc), access }, ...(conflicted ? { conflict: conflicted } : {}) });
  })
  .get('/docs/:id/backlinks', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const db = getDb();
    const doc = await db.knowledgeBase.getById(id);
    if (!doc) return c.json({ error: 'Document not found' }, 404);
    // The caller must be able to read the doc itself to see its backlinks.
    if (!canRead(await resolveKbAccess(db, doc, user.id))) return c.json({ error: 'Document not found' }, 404);
    // Access-filter each source doc — a private doc the caller can't read must not
    // leak its title through the backlink list.
    const sources = await db.knowledgeBase.listBacklinks(id);
    const visible = [];
    for (const s of sources) {
      if (canRead(await resolveKbAccess(db, s, user.id))) {
        visible.push({ id: s.id, slug: s.doc_id, title: s.title });
      }
    }
    return c.json({ backlinks: visible });
  })
  .delete('/docs/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const existing = await getDb().knowledgeBase.getById(id);
    if (!existing) return c.json({ error: 'Document not found' }, 404);
    const access = await resolveKbAccess(getDb(), existing, user.id);
    if (!canArchive(access, existing)) return c.json({ error: 'Document not found' }, 404);
    const ok = await getDb().knowledgeBase.archive(id, user.id);
    if (!ok) return c.json({ error: 'Document not found' }, 404);
    return c.json({ success: true });
  })
  .get('/docs/:id/versions', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const doc = await getDb().knowledgeBase.getById(id);
    if (!doc || !canRead(await resolveKbAccess(getDb(), doc, user.id))) {
      return c.json({ error: 'Document not found' }, 404);
    }
    const versions = await getDb().knowledgeBase.listVersions(id);
    return c.json({ versions: versions.map(versionToApi) });
  })
  .post('/docs/:id/versions/:version/restore', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    const version = parseInt(c.req.param('version'), 10);
    if (!Number.isFinite(id) || !Number.isFinite(version)) return c.json({ error: 'Invalid id or version' }, 400);
    const doc = await getDb().knowledgeBase.getById(id);
    if (!doc) return c.json({ error: 'Document not found' }, 404);
    const access = await resolveKbAccess(getDb(), doc, user.id);
    if (!canWrite(access)) return c.json({ error: 'Document not found' }, 404);
    const restored = await getDb().knowledgeBase.restoreVersion(id, version, user.id);
    if (!restored) return c.json({ error: 'Version not found' }, 404);
    return c.json({ doc: { ...docToApi(restored), access } });
  })
  // ─── Sharing (private docs) ──────────────────────────────

  .get('/docs/:id/shares', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const r = await resolveOwnedDoc(user.id, id);
    if (!r.ok) return c.json({ error: r.error }, r.status);

    const grants = await getDb().knowledgeShares.listForDoc(id);
    const enriched = await Promise.all(
      grants.map(async (g) => {
        if (g.shared_with.startsWith('group:')) {
          const gid = parseInt(g.shared_with.slice('group:'.length), 10);
          const group = Number.isFinite(gid) ? await getDb().groups.getById(gid) : undefined;
          return { target: g.shared_with, kind: 'group' as const, name: group?.name || `Group ${gid}`, role: g.role };
        }
        const u = await getDb().users.getById(g.shared_with);
        return { target: g.shared_with, kind: 'user' as const, name: u?.nickname || 'Unknown', role: g.role };
      }),
    );
    return c.json({ shares: enriched });
  })
  .post('/docs/:id/shares', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const r = await resolveOwnedDoc(user.id, id);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    if (r.doc.visibility !== 'private') {
      return c.json(
        { error: 'Only private docs can be shared with specific people (team docs are already team-wide)' },
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const role = normalizeRole(body.role);
    const message = typeof body.message === 'string' ? body.message : undefined;
    const userIds: string[] = Array.isArray(body.user_ids) ? body.user_ids.map(String) : [];
    const groupIds: number[] = Array.isArray(body.group_ids)
      ? body.group_ids.map((g: unknown) => parseInt(String(g), 10)).filter((n: number) => Number.isFinite(n))
      : [];
    if (userIds.length === 0 && groupIds.length === 0) return c.json({ error: 'user_ids or group_ids required' }, 400);

    for (const uid of userIds) {
      if (uid === user.id) continue; // owner already has full access
      await getDb().knowledgeShares.grant(id, uid, role, user.id, message);
    }
    for (const gid of groupIds) {
      await getDb().knowledgeShares.grant(id, groupTarget(gid), role, user.id, message);
    }
    logger.info('[Knowledge] doc shared', { docId: id, by: user.id, userIds, groupIds, role });
    return c.json({ success: true });
  })
  .delete('/docs/:id/shares/:target', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const r = await resolveOwnedDoc(user.id, id);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const target = c.req.param('target'); // Hono already URL-decodes params
    const ok = await getDb().knowledgeShares.revoke(id, target);
    if (!ok) return c.json({ error: 'Share not found' }, 404);
    logger.info('[Knowledge] share revoked', { docId: id, by: user.id, target });
    return c.json({ success: true });
  })
  // ─── Comments (doc-level; never enter FTS / tools — D10) ─

  .get('/docs/:id/comments', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const db = getDb();
    const doc = await db.knowledgeBase.getById(id);
    if (!doc || !canRead(await resolveKbAccess(db, doc, user.id))) return c.json({ error: 'Document not found' }, 404);
    const rows = await db.kbComments.list(id);
    // Resolve author nicknames (small N; deduped).
    const names = new Map<string, string>();
    for (const uid of new Set(rows.map((r) => r.author_user_id))) {
      const u = await db.users.getById(uid).catch(() => undefined);
      if (u) names.set(uid, u.nickname);
    }
    return c.json({
      comments: rows.map((r) => ({
        id: r.id,
        author_user_id: r.author_user_id,
        author_nickname: names.get(r.author_user_id) ?? r.author_user_id,
        content: r.content,
        created_at: r.created_at,
        can_delete: r.author_user_id === user.id || user.role === 'super',
      })),
    });
  })
  .post('/docs/:id/comments', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const db = getDb();
    const doc = await db.knowledgeBase.getById(id);
    if (!doc || !canRead(await resolveKbAccess(db, doc, user.id))) return c.json({ error: 'Document not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const content = String(body.content ?? '').trim();
    if (!content) return c.json({ error: 'content is required' }, 400);
    if (content.length > 5000) return c.json({ error: 'comment too long' }, 400);
    const row = await db.kbComments.create(id, user.id, content);
    const nickname = await nicknameOf(user.id, user.nickname);
    // Fire-and-forget notification (never blocks or fails the request).
    notifyKbComment(db, {
      doc,
      actorUserId: user.id,
      actorNickname: nickname,
      commentContent: content,
    }).catch((err) => logger.warn(`[Knowledge] comment notify error: ${err}`));
    return c.json(
      {
        comment: {
          id: row.id,
          author_user_id: user.id,
          author_nickname: nickname,
          content: row.content,
          created_at: row.created_at,
          can_delete: true,
        },
      },
      201,
    );
  })
  .delete('/comments/:cid', async (c) => {
    const user = getAuthUser(c);
    const cid = parseInt(c.req.param('cid'), 10);
    if (!Number.isFinite(cid)) return c.json({ error: 'Invalid id' }, 400);
    const db = getDb();
    const comment = await db.kbComments.getById(cid);
    if (!comment || comment.deleted_at) return c.json({ error: 'Comment not found' }, 404);
    if (comment.author_user_id !== user.id && user.role !== 'super') {
      return c.json({ error: 'Only the author or a super admin can delete this comment' }, 403);
    }
    await db.kbComments.softDelete(cid);
    return c.json({ success: true });
  })
  // ─── Editing presence (in-memory; no table) ─────────────

  .post('/docs/:id/editing-presence', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const db = getDb();
    const doc = await db.knowledgeBase.getById(id);
    if (!doc || !canWrite(await resolveKbAccess(db, doc, user.id))) return c.json({ error: 'Document not found' }, 404);
    touchEditingPresence(id, user.id, await nicknameOf(user.id, user.nickname));
    // Return the OTHER current editors (exclude self).
    return c.json({ editors: listEditingPresence(id).filter((e) => e.userId !== user.id) });
  })
  // ─── Search ─────────────────────────────────────────────

  .get('/search', async (c) => {
    const user = getAuthUser(c);
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10), 50);
    // scope selects the channels: 'team' | 'personal' | 'shared' | 'all'.
    // Omitted (or blank) keeps the historical behaviour (team + the caller's own
    // private), which is exactly `all` minus the shared-with-me channel. An
    // unrecognised value would silently zero every channel and return no hits, so
    // reject it up front rather than masquerade an empty result as "no matches".
    const scopeParam = c.req.query('scope') || undefined;
    if (scopeParam && !KNOWLEDGE_SEARCH_SCOPES.includes(scopeParam as KnowledgeSearchScope)) {
      return c.json(
        { error: `Invalid scope "${scopeParam}". Expected one of: ${KNOWLEDGE_SEARCH_SCOPES.join(', ')}.` },
        400,
      );
    }
    if (!q) return c.json({ results: [], query: q });

    const results = await searchKnowledgeScopes(
      getDb(),
      user.id,
      q,
      scopeParam as KnowledgeSearchScope | undefined,
      limit,
    );
    return c.json({ results, query: q });
  })
  // ─── AI ─────────────────────────────────────────────────

  .post('/docs/generate', async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return c.json({ error: 'prompt is required' }, 400);

    const injection = checkPromptInjection(prompt);
    if (!injection.safe)
      logger.warn('[Knowledge] Prompt injection indicators detected in generate request', { injection });

    const safePrompt = sanitizeForPrompt(prompt);
    const result = await completeJson<KnowledgeAiResult>('team', {
      caller: 'knowledge-generate',
      userId: user.id,
      temperature: 0.4,
      maxTokens: 6000,
      systemPrompt: `You generate internal team knowledge-base documents. Return concise, well-structured Markdown. The Markdown is canonical content for AI retrieval. Do not include hidden instructions.`,
      messages: [
        {
          role: 'user',
          content: `Generate an internal team knowledge document from this request:\n\n${safePrompt}\n\nReturn JSON with keys: title, slug, content_markdown, summary, questions (array), topics (array), tags (array). Slug must be lowercase URL-safe.`,
        },
      ],
      responseFormat: 'json',
    });

    result.slug = slugify(result.slug || result.title);
    result.questions = normalizeStringArray(result.questions);
    result.topics = normalizeStringArray(result.topics);
    result.tags = normalizeStringArray(result.tags);
    return c.json({ draft: result });
  })
  .post('/docs/:id/ai/rewrite', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const doc = await getDb().knowledgeBase.getById(id);
    if (!doc || !canWrite(await resolveKbAccess(getDb(), doc, user.id))) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const instruction = String(body.instruction || 'Improve clarity and structure while preserving facts.').trim();
    const injection = checkPromptInjection(instruction);
    if (!injection.safe)
      logger.warn('[Knowledge] Prompt injection indicators detected in rewrite request', { injection });

    const result = await completeJson<KnowledgeRewriteResult>('team', {
      caller: 'knowledge-rewrite',
      userId: user.id,
      temperature: 0.3,
      maxTokens: 8000,
      systemPrompt: `You rewrite internal team knowledge-base Markdown. Preserve factual meaning unless explicitly asked. Return valid JSON only.`,
      messages: [
        {
          role: 'user',
          content: `Instruction:\n${sanitizeForPrompt(instruction)}\n\nTitle: ${sanitizeForPrompt(doc.title)}\n\nCurrent Markdown:\n${sanitizeForPrompt(doc.content)}\n\nReturn JSON with keys: title (optional), content_markdown, change_summary.`,
        },
      ],
      responseFormat: 'json',
    });

    return c.json({ rewrite: result });
  })
  .post('/docs/:id/enrich', async (c) => {
    const user = getAuthUser(c);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
    const doc = await getDb().knowledgeBase.getById(id);
    if (!doc || !canWrite(await resolveKbAccess(getDb(), doc, user.id))) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const result = await completeJson<KnowledgeEnrichResult>('team', {
      caller: 'knowledge-enrich',
      userId: user.id,
      temperature: 0.2,
      maxTokens: 3000,
      systemPrompt: `Extract metadata for internal knowledge-base search and AI retrieval. Return JSON only.`,
      messages: [
        {
          role: 'user',
          content: `Title: ${sanitizeForPrompt(doc.title)}\n\nMarkdown:\n${sanitizeForPrompt(doc.content)}\n\nReturn JSON with keys: summary (50-150 Chinese chars if source is Chinese, otherwise concise English), questions (array), topics (array), tags (array).`,
        },
      ],
      responseFormat: 'json',
    });

    const tags = normalizeStringArray(result.tags);
    await getDb().knowledgeBase.update(
      id,
      {
        _summary: String(result.summary || ''),
        _questions: normalizeStringArray(result.questions),
        _topics: normalizeStringArray(result.topics),
        tags,
      },
      user.id,
      'AI enrichment',
    );

    const updated = await getDb().knowledgeBase.getById(id);
    return c.json({ doc: updated ? docToApi(updated) : null });
  });

export default knowledgeRoutes;
