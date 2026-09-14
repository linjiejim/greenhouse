/**
 * 全局搜索路由 — /api/search
 *
 * GET /api/search  — 跨会话 / 项目 / 知识库的聚合搜索，按种类分组返回
 *
 * 设计要点（决策见 docs/specs/20260804-entity-references-and-peek.md D14–D17）：
 *
 * - **每个域一条独立 lane**，各自走自己的 Platform action、各自 try/catch。任何一域
 *   不可用（未开通、无权限、报错）只让那一组为空，不影响其余结果。
 * - **不做跨域相关性排序**：项目全是 ILIKE 没有 relevance，知识库是 ts_rank(<1)，
 *   两者不可比。分组返回，组内保持各自的最佳顺序。
 * - **权限逐 lane 判定，不能挂在路由上**：某个应用未授权只让那一组为空，不能让整个
 *   搜索 403。
 */

import { Hono } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { SEARCHABLE_KINDS, type SearchGroup, type SearchHit, type SearchKind } from '@greenhouse/types/search';
import { getDb } from '@greenhouse/db';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import { humanActor } from '../platform/actor.js';
import { projectResource } from '../platform/projects/application.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { searchKnowledgeScopes } from '../knowledge/search.js';
import { extensionSearchSources } from '../search/sources.js';

/** Rows per kind when every kind is shown side by side. */
const GROUP_LIMIT = 5;
/** Rows when the caller drilled into a single kind. */
const KIND_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;

/** Join the non-empty parts of a subtitle so blank columns don't leave " · · ". */
function subtitle(...parts: Array<unknown>): string | undefined {
  const text = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' · ');
  return text || undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createSearchRoute() {
  return (
    new Hono<AppEnv>()
      // `/*` does not match the bare path, so the guard is mounted here rather
      // than as `.use('/api/search/*')` at the mount site — otherwise
      // `GET /api/search` would fall through to the global Bearer check alone.
      .use('*', requireInternal())

      .get('/', async (c) => {
        const user = getAuthUser(c);
        const query = (c.req.query('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
        const kindParam = c.req.query('kind');
        // Core kinds plus the ones active extensions registered a lane for.
        const searchableKinds: readonly SearchKind[] = [
          ...SEARCHABLE_KINDS,
          ...extensionSearchSources().map((source) => source.kind as SearchKind),
        ];
        const kind = searchableKinds.find((k) => k === kindParam);
        if (kindParam && !kind) return c.json({ error: `Unknown kind "${kindParam}"` }, 400);
        if (!query) return c.json({ query, groups: [] as SearchGroup[] });

        const limit = kind ? KIND_LIMIT : GROUP_LIMIT;
        // One row more than we show: `hasMore` then costs nothing, where a real
        // total would cost a COUNT per domain on every keystroke.
        const fetchLimit = limit + 1;
        const db = getDb();
        const actor = humanActor(user, c);

        /** A failed lane is an empty lane: one broken domain must not blank the palette. */
        const lane = async (k: SearchKind, run: () => Promise<SearchHit[]>): Promise<SearchGroup | null> => {
          if (kind && kind !== k) return null;
          let hits: SearchHit[] = [];
          try {
            hits = await run();
          } catch (err) {
            logger.warn('[search] lane failed', { kind: k, error: String(err) });
          }
          return { kind: k, items: hits.slice(0, limit), hasMore: hits.length > limit };
        };

        const [sessionHistory, projects, docs] = await Promise.all([
          lane('session', async () => {
            const rows = await db.sessions.searchByTitle(user.id, query, fetchLimit, 'web');
            return rows.map((row) => ({
              sessionId: row.id,
              title: row.title ?? '',
              subtitle: subtitle(row.updated_at),
            }));
          }),
          // Projects owns its whole read path in the registry handler (policy →
          // access → query), so this only has to hand it a payload.
          lane('project', async () => {
            const result = await getPlatformRuntime().dispatch({
              actor,
              appId: 'projects',
              actionId: 'listProjects',
              payload: { search: query, limit: fetchLimit },
              resource: projectResource('listProjects', {}),
            });
            if (!result.ok) return [];
            const rows = (result.data as { projects?: Record<string, unknown>[] }).projects ?? [];
            return rows.map((row) => ({
              ref: { kind: 'project' as const, id: Number(row.id) },
              title: text(row.title),
              subtitle: subtitle(row.status, row.priority),
            }));
          }),
          // Knowledge has no dispatch wrapper around search (its capability check
          // lives in the HTTP middleware's path match), so the gate is explicit
          // here and the channel combination is the shared implementation.
          lane('kb_doc', async () => {
            const decision = await getPlatformRuntime().authorize(actor, 'knowledge.library.read');
            if (!decision.allowed) return [];
            const hits = await searchKnowledgeScopes(db, user.id, query, 'all', fetchLimit);
            return hits.map((hit) => ({
              ref: { kind: 'kb_doc' as const, id: hit.id, slug: hit.slug },
              title: hit.title,
              // The authored summary only — never the body snippet. A Markdown
              // excerpt dressed up as a summary is how "# 标题 [链接](#/...)"
              // ends up rendered as a description (existing convention, see
              // apps/web/src/lib/search-summary.ts).
              subtitle: subtitle(hit.summary),
            }));
          }),
        ]);

        // Extension lanes run after the core three, in registration order, and
        // are just as isolated: a failing one leaves its group empty.
        const extensionGroups = await Promise.all(
          extensionSearchSources().map((source) =>
            lane(source.kind as SearchKind, () =>
              source.search({ query, limit: fetchLimit, userId: user.id, userRole: user.role, db }),
            ),
          ),
        );

        const groups = [sessionHistory, projects, docs, ...extensionGroups].filter((g): g is SearchGroup => g !== null);
        return c.json({ query, groups });
      })
  );
}
