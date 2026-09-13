/**
 * skillhub boot-seed tests — idempotent publish semantics over fixture packs
 * on disk plus the same in-memory skills/store fakes as center.test.ts.
 * Filesystem parity with scripts/skillhub-sync.mjs is pinned separately in
 * tests/skillhub/boot-seed-parity.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nowIso } from '@greenhouse/utils/date';
import type { DatabaseProvider, SkillRow, SkillVersionRow, UserRow } from '@greenhouse/db';
import type { SkillCreateInput, SkillVersionInput, SkillMetaUpdateInput, SkillScanResultInput } from '@greenhouse/db';
import { _resetSkillStoreForTests, _setSkillStoreForTests, type SkillStore } from './store.js';
import { resolveSkillhubDir, resolveSeedOwner, seedSkillhub } from './boot-seed.js';

// ─── In-memory fakes (same shape as center.test.ts) ──────

function memoryStore(): SkillStore {
  const objects = new Map<string, string>();
  return {
    backend: 'local',
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

function fakeUser(overrides: Partial<UserRow>): UserRow {
  return {
    id: 'u-1',
    email: 'a@example.com',
    password_hash: 'x',
    role: 'team',
    status: 'active',
    daily_message_limit: 200,
    monthly_token_limit: 20000000,
    created_by: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  } as UserRow;
}

function memoryDb(users: UserRow[]) {
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
        scan_status: 'pending',
        scan_findings: '[]',
        scan_version: null,
        scanned_at: null,
        scan_reviewed_by: null,
        scan_reviewed_at: null,
        scan_note: null,
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
      return row;
    },
    async getByName(name: string): Promise<SkillRow | undefined> {
      return rows.find((r) => r.name === name);
    },
    async getById(id: number): Promise<SkillRow | undefined> {
      return rows.find((r) => r.id === id);
    },
    async getVersion(skillId: number, version: string): Promise<SkillVersionRow | undefined> {
      return versions.find((v) => v.skill_id === skillId && v.version === version);
    },
    async listVersions(skillId: number): Promise<SkillVersionRow[]> {
      return versions.filter((v) => v.skill_id === skillId);
    },
    async updateMeta(id: number, updates: SkillMetaUpdateInput): Promise<SkillRow | undefined> {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      if (updates.display_name !== undefined) row.display_name = updates.display_name;
      if (updates.description !== undefined) row.description = updates.description;
      if (updates.tags !== undefined) row.tags = JSON.stringify(updates.tags);
      return row;
    },
    async setScanResult(id: number, input: SkillScanResultInput): Promise<SkillRow | undefined> {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      row.scan_status = input.status;
      row.scan_findings = JSON.stringify(input.findings);
      row.scan_version = input.version;
      row.scanned_at = nowIso();
      return row;
    },
    async incrementDownloads(): Promise<void> {},
  };

  const usersService = {
    async getByEmail(email: string): Promise<UserRow | undefined> {
      return users.find((u) => u.email === email);
    },
    async list(): Promise<UserRow[]> {
      return [...users];
    },
  };

  return { skills, users: usersService } as unknown as DatabaseProvider;
}

// ─── Fixture packs on disk ───────────────────────────────

function writePack(root: string, group: string, name: string, version: string, body: string): void {
  const dir = join(root, group, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的测试描述内容\nversion: ${version}\n---\n\n# ${name} 标题\n\n${body}\n`,
  );
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    `# 更新记录\n\n## ${version} - 2026-07-23\n\n${name} 的 ${version} 变更。\n`,
  );
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skillhub-seed-'));
  _setSkillStoreForTests(memoryStore());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  _resetSkillStoreForTests();
});

const superUser = fakeUser({ id: 'u-super', email: 'jim@example.com', role: 'super' });
const env = {} as NodeJS.ProcessEnv;

describe('resolveSkillhubDir', () => {
  it('env 覆盖优先，目录不存在时回落', () => {
    expect(resolveSkillhubDir({ SKILLHUB_DIR: root } as NodeJS.ProcessEnv)).toBe(root);
    // 不存在的 env 路径回落到模块相对定位（仓库真实 skillhub/）
    const fallback = resolveSkillhubDir({ SKILLHUB_DIR: join(root, 'missing') } as NodeJS.ProcessEnv);
    expect(fallback?.endsWith('skillhub')).toBe(true);
  });
});

describe('resolveSeedOwner', () => {
  it('默认取最早的 active super', async () => {
    const db = memoryDb([fakeUser({ id: 'u-team', role: 'team' }), superUser]);
    expect(await resolveSeedOwner(db, env)).toEqual({ userId: 'u-super', role: 'super' });
  });

  it('env 指定邮箱且必须是 active 用户', async () => {
    const db = memoryDb([
      superUser,
      fakeUser({ id: 'u-2', email: 'b@example.com', status: 'disabled' }),
      fakeUser({ id: 'u-team', email: 'team@example.com', role: 'team' }),
    ]);
    expect(await resolveSeedOwner(db, { SKILLHUB_SEED_OWNER_EMAIL: 'jim@example.com' } as NodeJS.ProcessEnv)).toEqual({
      userId: 'u-super',
      role: 'super',
    });
    expect(await resolveSeedOwner(db, { SKILLHUB_SEED_OWNER_EMAIL: 'b@example.com' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      await resolveSeedOwner(db, { SKILLHUB_SEED_OWNER_EMAIL: 'team@example.com' } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(await resolveSeedOwner(db, { SKILLHUB_SEED_OWNER_EMAIL: 'nobody@x.com' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('没有 super 时返回 null', async () => {
    const db = memoryDb([fakeUser({ id: 'u-team', role: 'team' })]);
    expect(await resolveSeedOwner(db, env)).toBeNull();
  });
});

describe('seedSkillhub', () => {
  it('首启全部首发，重启全部跳过（幂等）', async () => {
    writePack(root, 'apps', 'pack-a', '0.1.0', '甲');
    writePack(root, 'core', 'pack-b', '0.1.0', '乙');
    const db = memoryDb([superUser]);
    const seedEnv = { SKILLHUB_DIR: root } as NodeJS.ProcessEnv;

    const first = await seedSkillhub(db, seedEnv);
    expect(first?.published.sort()).toEqual(['pack-a@0.1.0', 'pack-b@0.1.0']);
    expect(first?.errors).toEqual([]);

    const skill = await db.skills.getByName('pack-a');
    expect(skill?.owner_user_id).toBe('u-super');
    expect(JSON.parse(skill!.tags)).toEqual(['official', 'apps']);
    expect(skill?.display_name).toBe('pack-a 标题');

    const second = await seedSkillhub(db, seedEnv);
    expect(second?.published).toEqual([]);
    expect(second?.skipped.sort()).toEqual(['pack-a', 'pack-b']);
  });

  it('内容变了没 bump 记错不发布，bump 后按新版发布', async () => {
    writePack(root, 'apps', 'pack-a', '0.1.0', '甲');
    const db = memoryDb([superUser]);
    const seedEnv = { SKILLHUB_DIR: root } as NodeJS.ProcessEnv;
    await seedSkillhub(db, seedEnv);

    writePack(root, 'apps', 'pack-a', '0.1.0', '甲改'); // 内容变、版本没动
    const bad = await seedSkillhub(db, seedEnv);
    expect(bad?.published).toEqual([]);
    expect(bad?.errors.join()).toContain('版本未递增');
    expect((await db.skills.getByName('pack-a'))?.latest_version).toBe('0.1.0');

    writePack(root, 'apps', 'pack-a', '0.2.0', '甲改');
    const good = await seedSkillhub(db, seedEnv);
    expect(good?.published).toEqual(['pack-a@0.2.0']);
    expect((await db.skills.getByName('pack-a'))?.latest_version).toBe('0.2.0');
  });

  it('缺 changelog 条目、frontmatter 与目录不一致都记错且不影响其他包', async () => {
    writePack(root, 'apps', 'pack-ok', '0.1.0', '好');
    writePack(root, 'apps', 'pack-bad', '0.1.0', '坏');
    writeFileSync(join(root, 'apps', 'pack-bad', 'CHANGELOG.md'), '# 更新记录\n'); // 抹掉版本条目
    const db = memoryDb([superUser]);

    const result = await seedSkillhub(db, { SKILLHUB_DIR: root } as NodeJS.ProcessEnv);
    expect(result?.published).toEqual(['pack-ok@0.1.0']);
    expect(result?.errors.join()).toContain('pack-bad');
  });

  it('没有 owner 时整体跳过返回 null', async () => {
    writePack(root, 'apps', 'pack-a', '0.1.0', '甲');
    const db = memoryDb([fakeUser({ id: 'u-team', role: 'team' })]);
    expect(await seedSkillhub(db, { SKILLHUB_DIR: root } as NodeJS.ProcessEnv)).toBeNull();
  });
});
