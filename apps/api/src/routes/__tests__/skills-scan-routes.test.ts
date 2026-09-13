/**
 * Security-review endpoints are super-only, and the download route must forward
 * the caller's identity.
 *
 * The role check itself lives in skills/center.ts (one implementation shared by
 * the routes and the agent tools), so what is pinned here is the wiring: that
 * the routes reach it with the real caller, map its codes to HTTP statuses, and
 * validate the decision value before it gets that far. A download route that
 * forgot to pass an actor would silently downgrade every request to the
 * strictest bucket — quarantined skills would 403 even for the super trying to
 * review them, which is the one thing that must keep working.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { SkillRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  db: { skills: {} },
  downloadSkill: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => mocks.db,
}));

vi.mock('../../skills/center.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../skills/center.js')>();
  return { ...actual, downloadSkill: mocks.downloadSkill };
});

const skills = (await import('../skills.js')).default;

const USERS = {
  member: { id: 'u-member', role: 'team' },
  admin: { id: 'u-admin', role: 'super' },
};

function app() {
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const key = c.req.header('x-test-user') as keyof typeof USERS | undefined;
    const user = key ? USERS[key] : undefined;
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    c.set('user', user as never);
    return next();
  });
  hono.route('/api/skills', skills);
  return hono;
}

function post(path: string, as: keyof typeof USERS, body?: unknown) {
  return app().request(path, {
    method: 'POST',
    headers: { 'x-test-user': as, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

const suspiciousRow = {
  id: 1,
  name: 'evil-skill',
  display_name: 'Evil Skill',
  description: 'x',
  tags: '[]',
  latest_version: '0.1.0',
  status: 'active',
  owner_user_id: 'u-owner',
  download_count: 0,
  scan_status: 'suspicious',
  scan_findings: '[]',
  scan_version: '0.1.0',
  scanned_at: '2026-08-05T00:00:00Z',
  scan_reviewed_by: null,
  scan_reviewed_at: null,
  scan_note: null,
  created_at: '2026-08-05T00:00:00Z',
  updated_at: '2026-08-05T00:00:00Z',
} satisfies SkillRow;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.skills = {
    getByName: vi.fn(async () => suspiciousRow),
    setScanDecision: vi.fn(async () => ({ ...suspiciousRow, scan_status: 'clean' as const })),
    // rescan runs the real center path (a module-level mock cannot intercept
    // center.ts's own call to downloadSkill), so give it enough surface to
    // resolve to a clean "bundle is gone" outcome.
    getVersion: vi.fn(async () => undefined),
  };
});

describe('POST /api/skills/:name/scan-decision', () => {
  it('403s for a non-super', async () => {
    const res = await post('/api/skills/evil-skill/scan-decision', 'member', { decision: 'clean' });
    expect(res.status).toBe(403);
    expect((mocks.db.skills as { setScanDecision: ReturnType<typeof vi.fn> }).setScanDecision).not.toHaveBeenCalled();
  });

  it('accepts clean / blocked from a super and records the reviewer', async () => {
    const res = await post('/api/skills/evil-skill/scan-decision', 'admin', { decision: 'clean', note: 'reviewed' });
    expect(res.status).toBe(200);
    expect((mocks.db.skills as { setScanDecision: ReturnType<typeof vi.fn> }).setScanDecision).toHaveBeenCalledWith(1, {
      status: 'clean',
      reviewed_by: 'u-admin',
      note: 'reviewed',
    });
  });

  it('400s on a decision value outside the two rulings', async () => {
    for (const decision of ['suspicious', 'pending', '', undefined]) {
      const res = await post('/api/skills/evil-skill/scan-decision', 'admin', { decision });
      expect(res.status, `decision=${String(decision)}`).toBe(400);
    }
  });

  it('404s for an unknown skill', async () => {
    (mocks.db.skills as { getByName: ReturnType<typeof vi.fn> }).getByName = vi.fn(async () => undefined);
    const res = await post('/api/skills/nope/scan-decision', 'admin', { decision: 'clean' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/skills/:name/rescan', () => {
  it('403s for a non-super', async () => {
    expect((await post('/api/skills/evil-skill/rescan', 'member')).status).toBe(403);
  });

  it('reaches the center for a super and surfaces a bundle read failure as 404', async () => {
    const res = await post('/api/skills/evil-skill/rescan', 'admin');
    expect(res.status).toBe(404);
    // It got past the role gate and actually tried to re-read the latest version.
    expect((mocks.db.skills as { getVersion: ReturnType<typeof vi.fn> }).getVersion).toHaveBeenCalledWith(1, '0.1.0');
  });
});

describe('GET /api/skills/:name/download', () => {
  it('forwards the caller as the actor so quarantine gating can see who is asking', async () => {
    mocks.downloadSkill.mockResolvedValue({ ok: true, skill: {}, version: {}, files: [] });
    const res = await app().request('/api/skills/evil-skill/download?version=0.1.0', {
      headers: { 'x-test-user': 'admin' },
    });
    expect(res.status).toBe(200);
    expect(mocks.downloadSkill).toHaveBeenCalledWith(mocks.db, 'evil-skill', '0.1.0', {
      meter: true,
      actor: { userId: 'u-admin', role: 'super' },
    });
  });

  it('keeps meter:false for passive browsing', async () => {
    mocks.downloadSkill.mockResolvedValue({ ok: true, skill: {}, version: {}, files: [] });
    await app().request('/api/skills/evil-skill/download?meter=false', { headers: { 'x-test-user': 'member' } });
    expect(mocks.downloadSkill).toHaveBeenCalledWith(mocks.db, 'evil-skill', undefined, {
      meter: false,
      actor: { userId: 'u-member', role: 'team' },
    });
  });

  it('maps a quarantine refusal to 403', async () => {
    mocks.downloadSkill.mockResolvedValue({ ok: false, code: 'forbidden', error: 'pending security review' });
    const res = await app().request('/api/skills/evil-skill/download', { headers: { 'x-test-user': 'member' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'pending security review' });
  });
});
