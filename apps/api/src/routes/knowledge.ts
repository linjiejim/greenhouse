/**
 * Knowledge routes — /api/knowledge (team + personal docs)
 *
 * GET    /api/knowledge/docs                          — 文档列表（默认：团队 + 本人个人文档）
 * POST   /api/knowledge/docs                          — 创建文档
 * GET    /api/knowledge/docs/:slug                    — 按 slug 获取文档详情
 * PUT    /api/knowledge/docs/:id                      — 更新文档并记录版本
 * DELETE /api/knowledge/docs/:id                      — 归档文档（软删除）
 * GET    /api/knowledge/docs/:id/versions             — 获取文档版本历史
 * POST   /api/knowledge/docs/:id/versions/:v/restore  — 回滚到指定版本（记录为新版本）
 * POST   /api/knowledge/spaces/rename                 — 批量重命名团队 space（含嵌套子树）
 * POST   /api/knowledge/docs/generate                 — AI 生成文档草稿
 * POST   /api/knowledge/docs/:id/ai/rewrite           — AI 改写当前文档
 * POST   /api/knowledge/docs/:id/enrich               — AI 生成 summary/questions/topics/tags
 * GET    /api/knowledge/search                        — 搜索团队知识库
 * GET    /api/knowledge/docs/:id/shares               — 私有文档的共享列表
 * POST   /api/knowledge/docs/:id/shares               — 添加/更新共享（user/group, reader/editor）
 * DELETE /api/knowledge/docs/:id/shares/:target       — 撤销共享
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
import { randomDocId } from '@greenhouse/utils/id';
import { markdownToTiptapJson } from '@greenhouse/knowledge-editor/markdown';
import { getAuthUser } from '../auth/middleware.js';
import { checkPromptInjection, sanitizeForPrompt } from '../security.js';
import { completeJson } from '../llm/complete.js';
import { resolveKbAccess, canRead, canWrite, canArchive, canManageSharing } from '../knowledge-access.js';
import type { AppEnv } from '../app-env.js';

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

/**
 * Canonicalize a KB space path. Spaces are `/`-delimited to express nesting
 * (`eng/backend`); this trims each segment, drops empties (collapsing `//` and
 * stray slashes), and falls back to `general`. Applied on every write so the
 * stored value is always the canonical form the nav tree groups by.
 */
function normalizeSpacePath(raw: string): string {
  return (
    raw
      .split('/')
      .map((seg) => seg.trim())
      .filter(Boolean)
      .join('/') || 'general'
  );
}

function buildMeta(space: unknown, meta: unknown): Record<string, unknown> {
  const base =
    typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  const raw = typeof space === 'string' && space.trim() ? space : (base.space as string) || 'general';
  base.space = normalizeSpacePath(raw);
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

const knowledgeRoutes = new Hono<AppEnv>()
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
    // Doc ids are system-assigned and random — never derived from the title, so
    // behaviour is identical for every language. Retry on the astronomically
    // unlikely collision rather than surfacing an error.
    let slug = randomDocId();
    while (await getDb().knowledgeBase.get(slug, 'shared')) slug = randomDocId();

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
      visibility: normalizeVisibility(body.visibility),
      status: normalizeStatus(body.status),
      tags: normalizeStringArray(body.tags),
      meta: buildMeta(body.space, body.meta),
      owner_user_id: user.id,
      created_by: user.id,
      updated_by: user.id,
      _summary: String(body.summary || ''),
      _questions: normalizeStringArray(body.questions),
      _topics: normalizeStringArray(body.topics),
    });
    return c.json({ doc: docToApi(row) }, 201);
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
    // doc_id is immutable once assigned — keeps URLs and agent references stable.
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
    if (body.tags !== undefined) updates.tags = normalizeStringArray(body.tags);
    if (body.space !== undefined || body.meta !== undefined) updates.meta = buildMeta(body.space, body.meta);
    if (body.summary !== undefined) updates._summary = String(body.summary || '');
    if (body.questions !== undefined) updates._questions = normalizeStringArray(body.questions);
    if (body.topics !== undefined) updates._topics = normalizeStringArray(body.topics);

    const doc = await getDb().knowledgeBase.update(
      id,
      updates as any,
      user.id,
      String(body.change_reason || 'Updated from editor'),
    );
    if (!doc) return c.json({ error: 'Document not found' }, 404);
    return c.json({ doc: { ...docToApi(doc), access } });
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
  // ─── Spaces (team KB categories) ─────────────────────────
  //
  // Spaces aren't a first-class table — they're the `/`-delimited `meta.space`
  // path on each team doc, grouped into a tree in the nav. Renaming a space is a
  // bulk metadata move over every doc in that subtree. Team docs are
  // collaborative (any internal user can edit), so any internal user may rename.

  .post('/spaces/rename', async (c) => {
    const user = getAuthUser(c);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.from !== 'string' || !body.from.trim()) return c.json({ error: 'from is required' }, 400);
    if (typeof body.to !== 'string' || !body.to.trim()) return c.json({ error: 'to is required' }, 400);
    const from = normalizeSpacePath(body.from);
    const to = normalizeSpacePath(body.to);
    if (from === to) return c.json({ error: 'from and to are the same space' }, 400);

    const count = await getDb().knowledgeBase.renameSpace(from, to, user.id);
    logger.info('[Knowledge] space renamed', { from, to, count, by: user.id });
    return c.json({ success: true, from, to, count });
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
  // ─── Search ─────────────────────────────────────────────

  .get('/search', async (c) => {
    const user = getAuthUser(c);
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10), 50);
    if (!q) return c.json({ results: [], query: q });

    // Search team docs + the caller's own private docs — never another user's.
    const [team, mine] = await Promise.all([
      getDb().knowledgeBase.search(q, { scope: 'shared', status: 'published', visibility: 'team', limit }),
      getDb().knowledgeBase.search(q, {
        scope: 'shared',
        status: 'published',
        visibility: 'private',
        ownerUserId: user.id,
        limit,
      }),
    ]);
    const results = [...team, ...mine]
      .sort((a, b) => Number(b.relevance || 0) - Number(a.relevance || 0))
      .slice(0, limit);
    return c.json({
      results: results.map((r) => ({
        id: r.id,
        slug: r.doc_id,
        title: r.title,
        summary: r._summary || '',
        snippet: r.snippet,
        tags: r.tags || '[]',
        relevance: Number(r.relevance || 0),
      })),
      query: q,
    });
  })
  // ─── AI ─────────────────────────────────────────────────

  .post('/docs/generate', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return c.json({ error: 'prompt is required' }, 400);

    const injection = checkPromptInjection(prompt);
    if (!injection.safe)
      logger.warn('[Knowledge] Prompt injection indicators detected in generate request', { injection });

    const safePrompt = sanitizeForPrompt(prompt);
    const result = await completeJson<KnowledgeAiResult>('team', {
      caller: 'knowledge-generate',
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

    result.slug = randomDocId();
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
