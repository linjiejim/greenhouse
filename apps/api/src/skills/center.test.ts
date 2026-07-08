/**
 * Skill Center orchestration tests — publish/download/sync/manage semantics
 * over an in-memory skill store and an in-memory db.skills fake (the real
 * service is covered by tests/db/skills-service.test.ts against PostgreSQL).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nowIso } from '@greenhouse/utils/date';
import type { DatabaseProvider, SkillRow, SkillVersionRow } from '@greenhouse/db';
import type { SkillCreateInput, SkillVersionInput, SkillMetaUpdateInput, SkillListOpts } from '@greenhouse/db';
import { _resetSkillStoreForTests, _setSkillStoreForTests, type SkillStore } from './store.js';
import {
  publishSkill,
  downloadSkill,
  getSkillDetail,
  checkUpdates,
  updateSkillMeta,
  setSkillStatus,
  deleteSkill,
} from './center.js';

// ─── In-memory fakes ─────────────────────────────────────

function memoryStore(): SkillStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    backend: 'local',
    objects,
    async put(key, json) {
      objects.set(key, json);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function memoryDb() {
  let nextId = 1;
  let nextVersionId = 1;
  const rows: SkillRow[] = [];
  const versions: SkillVersionRow[] = [];

  const skills = {
    async create(input: SkillCreateInput, first: SkillVersionInput): Promise<SkillRow> {
      if (rows.some((r) => r.name === input.name)) throw new Error('duplicate name');
      const now = nowIso();
      const row: SkillRow = {
        id: nextId++,
        name: input.name,
        display_name: input.display_name || input.name,
        description: input.description,
        tags: JSON.stringify(input.tags ?? []),
        latest_version: first.version,
        status: 'active',
        owner_user_id: input.owner_user_id,
        download_count: 0,
        created_at: now,
        updated_at: now,
      };
      rows.push(row);
      versions.push({ id: nextVersionId++, skill_id: row.id, created_at: now, ...first });
      return row;
    },
    async addVersion(skillId: number, input: SkillVersionInput): Promise<SkillVersionRow> {
      if (versions.some((v) => v.skill_id === skillId && v.version === input.version)) throw new Error('dup version');
      const row: SkillVersionRow = { id: nextVersionId++, skill_id: skillId, created_at: nowIso(), ...input };
      versions.push(row);
      const skill = rows.find((r) => r.id === skillId)!;
      skill.latest_version = input.version;
      skill.updated_at = nowIso();
      return row;
    },
    async getById(id: number) {
      return rows.find((r) => r.id === id);
    },
    async getByName(name: string) {
      return rows.find((r) => r.name === name);
    },
    async list(_opts?: SkillListOpts) {
      return [...rows];
    },
    async count() {
      return rows.length;
    },
    async listVersions(skillId: number) {
      return versions.filter((v) => v.skill_id === skillId).sort((a, b) => b.id - a.id);
    },
    async getVersion(skillId: number, version: string) {
      return versions.find((v) => v.skill_id === skillId && v.version === version);
    },
    async updateMeta(skillId: number, updates: SkillMetaUpdateInput) {
      const skill = rows.find((r) => r.id === skillId);
      if (!skill) return undefined;
      if (updates.display_name !== undefined) skill.display_name = updates.display_name;
      if (updates.description !== undefined) skill.description = updates.description;
      if (updates.tags !== undefined) skill.tags = JSON.stringify(updates.tags);
      skill.updated_at = nowIso();
      return skill;
    },
    async setStatus(skillId: number, status: SkillRow['status']) {
      const skill = rows.find((r) => r.id === skillId);
      if (skill) skill.status = status;
      return skill;
    },
    async incrementDownloads(skillId: number) {
      const skill = rows.find((r) => r.id === skillId);
      if (skill) skill.download_count += 1;
    },
    async remove(skillId: number) {
      const idx = rows.findIndex((r) => r.id === skillId);
      if (idx === -1) return false;
      rows.splice(idx, 1);
      for (let i = versions.length - 1; i >= 0; i--) if (versions[i]!.skill_id === skillId) versions.splice(i, 1);
      return true;
    },
  };
  return { skills } as unknown as DatabaseProvider;
}

const OWNER = { userId: 'u-owner', role: 'team' };
const OTHER = { userId: 'u-other', role: 'team' };
const SUPER = { userId: 'u-admin', role: 'super' };

const skillMd = (name: string, description = 'Render PDFs') => ({
  path: 'SKILL.md',
  content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}`,
});

let db: DatabaseProvider;
let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  db = memoryDb();
  store = memoryStore();
  _setSkillStoreForTests(store);
});

afterEach(() => {
  _resetSkillStoreForTests();
});

describe('publishSkill — create', () => {
  it('creates a skill at 0.1.0, taking the description from SKILL.md frontmatter', async () => {
    const result = await publishSkill(db, OWNER, { name: 'pdf-report', files: [skillMd('pdf-report')] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.skill).toMatchObject({
      name: 'pdf-report',
      description: 'Render PDFs',
      latest_version: '0.1.0',
      owner_user_id: 'u-owner',
    });
    expect(result.version).toMatchObject({ version: '0.1.0', changelog: 'Initial release', file_count: 1 });
    expect(store.objects.has('pdf-report/0.1.0.json')).toBe(true);
  });

  it('rejects a frontmatter/skill name mismatch and a missing description', async () => {
    const mismatch = await publishSkill(db, OWNER, { name: 'other-name', files: [skillMd('pdf-report')] });
    expect(mismatch).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/does not match/) });

    const noDesc = await publishSkill(db, OWNER, {
      name: 'bare',
      files: [{ path: 'SKILL.md', content: '# no frontmatter' }],
    });
    expect(noDesc).toMatchObject({
      ok: false,
      code: 'invalid',
      error: expect.stringMatching(/description is required/),
    });
  });

  it('rejects invalid names and invalid bundles', async () => {
    expect((await publishSkill(db, OWNER, { name: 'Bad Name', files: [skillMd('x')] })).ok).toBe(false);
    expect((await publishSkill(db, OWNER, { name: 'ok-name', files: [] })).ok).toBe(false);
  });
});

describe('publishSkill — update', () => {
  beforeEach(async () => {
    await publishSkill(db, OWNER, { name: 'pdf-report', files: [skillMd('pdf-report')] });
  });

  it('requires a changelog and bumps the patch version by default', async () => {
    const noLog = await publishSkill(db, OWNER, {
      name: 'pdf-report',
      files: [skillMd('pdf-report'), { path: 'v2.md', content: 'x' }],
    });
    expect(noLog).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/changelog is required/) });

    const result = await publishSkill(db, OWNER, {
      name: 'pdf-report',
      changelog: 'Add v2 notes',
      files: [skillMd('pdf-report'), { path: 'v2.md', content: 'x' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.version.version).toBe('0.1.1');
    expect(store.objects.has('pdf-report/0.1.1.json')).toBe(true);
  });

  it('enforces monotonically increasing explicit versions', async () => {
    const result = await publishSkill(db, OWNER, {
      name: 'pdf-report',
      version: '0.1.0',
      changelog: 'stale',
      files: [skillMd('pdf-report'), { path: 'x.md', content: 'x' }],
    });
    expect(result).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/must be greater/) });
  });

  it('rejects a byte-identical republish', async () => {
    const result = await publishSkill(db, OWNER, {
      name: 'pdf-report',
      changelog: 'no-op',
      files: [skillMd('pdf-report')],
    });
    expect(result).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/identical/) });
  });

  it('only the owner or a super can push; archived skills refuse updates', async () => {
    const forbidden = await publishSkill(db, OTHER, {
      name: 'pdf-report',
      changelog: 'x',
      files: [skillMd('pdf-report'), { path: 'x.md', content: 'x' }],
    });
    expect(forbidden).toMatchObject({ ok: false, code: 'forbidden' });

    const asSuper = await publishSkill(db, SUPER, {
      name: 'pdf-report',
      changelog: 'super push',
      files: [skillMd('pdf-report'), { path: 'x.md', content: 'x' }],
    });
    expect(asSuper.ok).toBe(true);

    await setSkillStatus(db, OWNER, 'pdf-report', 'archived');
    const archived = await publishSkill(db, OWNER, {
      name: 'pdf-report',
      changelog: 'x',
      files: [skillMd('pdf-report'), { path: 'y.md', content: 'y' }],
    });
    expect(archived).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/archived/) });
  });

  it("a losing concurrent version publish must not delete the winner's shared bundle", async () => {
    // Simulate the race: our addVersion loses to a concurrent identical publish
    // (agent retry) that landed between our version-check and our insert.
    const files = [skillMd('pdf-report'), { path: 'retry.md', content: 'r' }];
    const real = db.skills.addVersion.bind(db.skills);
    db.skills.addVersion = async (id, input) => {
      await real(id, input); // the winner registers the row first…
      throw new Error('unique violation'); // …then our own insert fails
    };
    const result = await publishSkill(db, OWNER, { name: 'pdf-report', changelog: 'retry', files });
    db.skills.addVersion = real;

    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    // The bundle is shared with the winner's registered row — it must survive…
    expect(store.objects.has('pdf-report/0.1.1.json')).toBe(true);
    // …and the winner's version must still download cleanly.
    expect((await downloadSkill(db, 'pdf-report', '0.1.1')).ok).toBe(true);
  });

  it("a losing concurrent create must not delete the winner's bundle", async () => {
    // Stale read: we saw no existing skill, but the winner created it (same
    // retry payload) before our create committed.
    const realGet = db.skills.getByName.bind(db.skills);
    let stale = true;
    db.skills.getByName = async (name: string) => (stale ? ((stale = false), undefined) : realGet(name));
    const result = await publishSkill(db, OWNER, { name: 'pdf-report', files: [skillMd('pdf-report')] });
    db.skills.getByName = realGet;

    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(store.objects.has('pdf-report/0.1.0.json')).toBe(true);
    expect((await downloadSkill(db, 'pdf-report', '0.1.0')).ok).toBe(true);
  });
});

describe('downloadSkill', () => {
  beforeEach(async () => {
    await publishSkill(db, OWNER, { name: 'pdf-report', files: [skillMd('pdf-report')] });
    await publishSkill(db, OWNER, {
      name: 'pdf-report',
      changelog: 'Add helper',
      files: [skillMd('pdf-report'), { path: 'helper.md', content: 'help' }],
    });
  });

  it('serves the latest by default, a pinned version on demand, and counts downloads', async () => {
    const latest = await downloadSkill(db, 'pdf-report');
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.version.version).toBe('0.1.1');
    expect(latest.files.map((f) => f.path)).toEqual(['SKILL.md', 'helper.md']);

    const pinned = await downloadSkill(db, 'pdf-report', '0.1.0');
    expect(pinned.ok && pinned.version.version === '0.1.0').toBe(true);

    const detail = await getSkillDetail(db, 'pdf-report');
    expect(detail!.skill.download_count).toBe(2);
    expect(detail!.versions.map((v) => v.version)).toEqual(['0.1.1', '0.1.0']);
  });

  it('archived skills stay downloadable (pinned installs must not break)', async () => {
    await setSkillStatus(db, OWNER, 'pdf-report', 'archived');
    expect((await downloadSkill(db, 'pdf-report')).ok).toBe(true);
  });

  it('surfaces missing bundles and integrity failures instead of guessing', async () => {
    store.objects.delete('pdf-report/0.1.1.json');
    expect(await downloadSkill(db, 'pdf-report')).toMatchObject({ ok: false, code: 'not_found' });

    store.objects.set(
      'pdf-report/0.1.0.json',
      JSON.stringify({
        format: 1,
        name: 'pdf-report',
        version: '0.1.0',
        files: [{ path: 'SKILL.md', content: 'tampered' }],
      }),
    );
    expect(await downloadSkill(db, 'pdf-report', '0.1.0')).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('unknown skills / versions are not_found', async () => {
    expect(await downloadSkill(db, 'nope')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await downloadSkill(db, 'pdf-report', '9.9.9')).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('checkUpdates', () => {
  beforeEach(async () => {
    await publishSkill(db, OWNER, { name: 'pdf-report', files: [skillMd('pdf-report')] });
    await publishSkill(db, OWNER, {
      name: 'pdf-report',
      version: '0.2.0',
      changelog: 'Landscape mode',
      files: [skillMd('pdf-report'), { path: 'a.md', content: 'a' }],
    });
    await publishSkill(db, OWNER, {
      name: 'pdf-report',
      version: '1.0.0',
      changelog: 'Stable',
      files: [skillMd('pdf-report'), { path: 'b.md', content: 'b' }],
    });
    await publishSkill(db, OWNER, { name: 'excel-export', files: [skillMd('excel-export', 'Spreadsheets')] });
    await setSkillStatus(db, OWNER, 'excel-export', 'archived');
  });

  it('reports each installed skill with pending changelogs oldest-first', async () => {
    const report = await checkUpdates(db, [
      { name: 'pdf-report', version: '0.1.0' },
      { name: 'excel-export', version: '0.1.0' },
      { name: 'ghost', version: '1.0.0' },
      { name: 'pdf-report', version: 'garbage' },
    ]);

    expect(report[0]).toMatchObject({
      name: 'pdf-report',
      status: 'update_available',
      installed_version: '0.1.0',
      latest_version: '1.0.0',
    });
    expect(report[0]!.pending_changelogs!.map((c) => c.version)).toEqual(['0.2.0', '1.0.0']);
    expect(report[1]).toMatchObject({ name: 'excel-export', status: 'archived' });
    expect(report[2]).toMatchObject({ name: 'ghost', status: 'not_found' });
    expect(report[3]).toMatchObject({ name: 'pdf-report', status: 'invalid_version' });

    const upToDate = await checkUpdates(db, [{ name: 'pdf-report', version: '1.0.0' }]);
    expect(upToDate[0]).toMatchObject({ status: 'up_to_date' });
  });
});

describe('manage — meta / status / delete', () => {
  beforeEach(async () => {
    await publishSkill(db, OWNER, { name: 'pdf-report', files: [skillMd('pdf-report')] });
  });

  it('updateSkillMeta is owner/super-gated and validates description', async () => {
    expect(await updateSkillMeta(db, OTHER, 'pdf-report', { description: 'x' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await updateSkillMeta(db, OWNER, 'pdf-report', { description: '  ' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const updated = await updateSkillMeta(db, OWNER, 'pdf-report', { tags: ['pdf'], display_name: 'PDF Report' });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.skill).toMatchObject({ display_name: 'PDF Report', tags: ['pdf'] });
  });

  it('archive/unarchive round-trips; delete is super-only and clears the store', async () => {
    expect(await setSkillStatus(db, OTHER, 'pdf-report', 'archived')).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await setSkillStatus(db, OWNER, 'pdf-report', 'archived')).ok).toBe(true);
    expect((await setSkillStatus(db, SUPER, 'pdf-report', 'active')).ok).toBe(true);

    expect(await deleteSkill(db, OWNER, 'pdf-report')).toMatchObject({ ok: false, code: 'forbidden' });
    const deleted = await deleteSkill(db, SUPER, 'pdf-report');
    expect(deleted).toMatchObject({ ok: true, deleted_versions: 1 });
    expect(store.objects.size).toBe(0);
    expect(await getSkillDetail(db, 'pdf-report')).toBeNull();
  });
});
