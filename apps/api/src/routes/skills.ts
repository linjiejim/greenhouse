/**
 * Skill Center routes — /api/skills (internal users; see index.ts mount guard)
 *
 * GET    /api/skills                      — 列表 / 搜索（q、status、scan_status、分页）
 * GET    /api/skills/:name                — 详情 + 完整版本历史（含 changelog）
 * GET    /api/skills/:name/download       — 下载 bundle（?version= 指定版本，默认最新）
 * GET    /api/skills/:name/download.zip   — 下载完整、可安装的 ZIP 技能包
 * POST   /api/skills/publish              — 发布新技能 / 推送新版本（更新必须带 changelog）
 * PATCH  /api/skills/:name                — 更新目录元数据（owner / super）
 * POST   /api/skills/:name/archive        — 归档（owner / super）
 * POST   /api/skills/:name/unarchive      — 取消归档（owner / super）
 * POST   /api/skills/:name/scan-decision  — 安全扫描判定 clean / blocked（super）
 * POST   /api/skills/:name/rescan         — 对最新版本重跑安全扫描（super）
 * DELETE /api/skills/:name                — 彻底删除（super，连同存储对象）
 *
 * All heavy lifting lives in skills/center.ts — the SAME implementation the
 * skill_query / skill_mutation agent tools call.
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { SkillScanStatus, SkillStatus } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import type { SkillFile } from '../skills/bundle.js';
import { buildSkillArchive, skillArchiveFilename } from '../skills/archive.js';
import {
  checkUpdates,
  decideSkillScan,
  deleteSkill,
  downloadSkill,
  getSkillDetail,
  publishSkill,
  rescanSkill,
  setSkillStatus,
  toSkillSummary,
  updateSkillMeta,
  type SkillErrorCode,
} from '../skills/center.js';

const SCAN_STATUSES: SkillScanStatus[] = ['pending', 'clean', 'suspicious', 'blocked'];

const STATUS_BY_CODE: Record<SkillErrorCode, 400 | 403 | 404 | 409> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

const skills = new Hono<AppEnv>()
  /** GET / — list/search the catalog */
  .get('/', async (c) => {
    const q = c.req.query('q')?.trim() || undefined;
    const statusParam = c.req.query('status');
    const status: SkillStatus | undefined =
      statusParam === 'archived' ? 'archived' : statusParam === 'all' ? undefined : 'active';
    const scanParam = c.req.query('scan_status');
    const scan_status = SCAN_STATUSES.find((s) => s === scanParam);
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100);
    const offset = parseInt(c.req.query('offset') || '0', 10) || 0;

    const db = getDb();
    const [rows, total] = await Promise.all([
      db.skills.list({ q, status, scan_status, limit, offset }),
      db.skills.count({ q, status, scan_status }),
    ]);
    return c.json({ total, skills: rows.map(toSkillSummary) });
  })
  /** POST /publish — create a skill or push a new version */
  .post('/publish', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as {
      name?: string;
      display_name?: string;
      description?: string;
      tags?: string[];
      version?: string;
      changelog?: string;
      files?: SkillFile[];
    };
    if (!body.name || !Array.isArray(body.files)) {
      return c.json({ error: 'name and files are required' }, 400);
    }
    const result = await publishSkill(
      getDb(),
      { userId: user.id, role: user.role },
      {
        name: body.name,
        display_name: body.display_name,
        description: body.description,
        tags: body.tags,
        version: body.version,
        changelog: body.changelog,
        files: body.files,
      },
    );
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json(
      { created: result.created, skill: result.skill, version: result.version },
      result.created ? 201 : 200,
    );
  })
  /** POST /check-updates — sync check for locally installed skills */
  .post('/check-updates', async (c) => {
    const body = (await c.req.json()) as { installed?: { name?: string; version?: string }[] };
    if (!Array.isArray(body.installed) || body.installed.length === 0) {
      return c.json({ error: 'installed is required — [{ name, version }]' }, 400);
    }
    const refs = body.installed
      .filter(
        (r): r is { name: string; version: string } => typeof r?.name === 'string' && typeof r?.version === 'string',
      )
      .slice(0, 100);
    return c.json({ skills: await checkUpdates(getDb(), refs) });
  })
  /** GET /:name — detail + version history */
  .get('/:name', async (c) => {
    const detail = await getSkillDetail(getDb(), c.req.param('name'));
    if (!detail) return c.json({ error: 'Skill not found' }, 404);
    return c.json(detail);
  })
  /**
   * GET /:name/download — a version's file bundle (default: latest).
   * `?meter=false` skips the download counter (web browse). The caller's
   * identity is forwarded so quarantine gating can let the owner (fix &
   * republish) and a super (review the SKILL.md body) through — that is the
   * precondition for the review action being possible at all.
   */
  .get('/:name/download', async (c) => {
    const user = getAuthUser(c);
    const meter = c.req.query('meter') !== 'false';
    const result = await downloadSkill(getDb(), c.req.param('name'), c.req.query('version') || undefined, {
      meter,
      actor: { userId: user.id, role: user.role },
    });
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json({ skill: result.skill, version: result.version, files: result.files });
  })
  /** GET /:name/download.zip — complete installable package, metered once. */
  .get('/:name/download.zip', async (c) => {
    const user = getAuthUser(c);
    const result = await downloadSkill(getDb(), c.req.param('name'), c.req.query('version') || undefined, {
      actor: { userId: user.id, role: user.role },
    });
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);

    const bytes = buildSkillArchive(result.skill.name, result.files);
    const filename = skillArchiveFilename(result.skill.name, result.version.version);
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  })
  /** PATCH /:name — catalog metadata (owner / super) */
  .patch('/:name', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json()) as { display_name?: string; description?: string; tags?: string[] };
    const result = await updateSkillMeta(getDb(), { userId: user.id, role: user.role }, c.req.param('name'), body);
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json({ skill: result.skill });
  })
  /** POST /:name/archive — hide from discovery (owner / super) */
  .post('/:name/archive', async (c) => {
    const user = getAuthUser(c);
    const result = await setSkillStatus(getDb(), { userId: user.id, role: user.role }, c.req.param('name'), 'archived');
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json({ skill: result.skill });
  })
  /** POST /:name/unarchive — restore to discovery (owner / super) */
  .post('/:name/unarchive', async (c) => {
    const user = getAuthUser(c);
    const result = await setSkillStatus(getDb(), { userId: user.id, role: user.role }, c.req.param('name'), 'active');
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json({ skill: result.skill });
  })
  /** POST /:name/scan-decision — rule on a scan verdict: clean restores, blocked bans (super) */
  .post('/:name/scan-decision', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: string };
    if (body.decision !== 'clean' && body.decision !== 'blocked') {
      return c.json({ error: 'decision must be "clean" or "blocked"' }, 400);
    }
    const result = await decideSkillScan(
      getDb(),
      { userId: user.id, role: user.role },
      c.req.param('name'),
      body.decision,
      body.note,
    );
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json({ skill: result.skill });
  })
  /** POST /:name/rescan — re-run the scanner over the latest version (super) */
  .post('/:name/rescan', async (c) => {
    const user = getAuthUser(c);
    const result = await rescanSkill(getDb(), { userId: user.id, role: user.role }, c.req.param('name'));
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json({ skill: result.skill });
  })
  /** DELETE /:name — permanent removal incl. stored bundles (super) */
  .delete('/:name', async (c) => {
    const user = getAuthUser(c);
    const result = await deleteSkill(getDb(), { userId: user.id, role: user.role }, c.req.param('name'));
    if (!result.ok) return c.json({ error: result.error }, STATUS_BY_CODE[result.code]);
    return c.json({ deleted: true, deleted_versions: result.deleted_versions });
  });

export default skills;
