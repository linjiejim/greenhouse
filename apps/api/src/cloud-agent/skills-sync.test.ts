/**
 * Sandbox skills sync — which skills reach `~/.agents/skills`.
 *
 * The sync's removal pass deletes any directory not in the wanted set, which
 * makes the inclusion predicate load-bearing in a way that is easy to get
 * wrong: narrowing it to `scan_status === 'clean'` would, in the window between
 * a deploy and the boot backfill finishing, produce an empty wanted set and
 * wipe every skill out of every sandbox. So the predicate must mirror
 * downloadSkill's — quarantined out, `pending` in — and that is what this pins.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nowIso } from '@greenhouse/utils/date';
import type { DatabaseProvider, SkillRow, SkillScanStatus } from '@greenhouse/db';
import { _resetSkillStoreForTests, _setSkillStoreForTests, storageKeyFor, type SkillStore } from '../skills/store.js';
import { buildBundleJson, bundleContentHash } from '../skills/bundle.js';
import { _resetSkillsSync, ensureSkillsSynced, skillsDirFor } from './skills-sync.js';

function row(name: string, scan_status: SkillScanStatus, id: number): SkillRow {
  const now = nowIso();
  return {
    id,
    name,
    display_name: name,
    description: 'x',
    tags: '[]',
    latest_version: '1.0.0',
    status: 'active',
    owner_user_id: 'u1',
    download_count: 0,
    scan_status,
    scan_findings: '[]',
    scan_version: '1.0.0',
    scanned_at: scan_status === 'pending' ? null : now,
    scan_reviewed_by: scan_status === 'clean' ? 'u-super' : null,
    scan_reviewed_at: scan_status === 'clean' ? now : null,
    scan_note: null,
    created_at: now,
    updated_at: now,
  };
}

/** The one-file bundle every fake skill in this test resolves to. */
const filesFor = (name: string) => [{ path: 'SKILL.md', content: `# ${name}` }];

/** Serves a valid bundle for any key — the store is not what these tests exercise. */
function memoryStore(): SkillStore {
  return {
    backend: 'local',
    async put() {},
    async get(key: string) {
      const name = key.split('/')[0]!;
      return buildBundleJson(name, '1.0.0', filesFor(name));
    },
    async delete() {},
  };
}

const ROWS = [
  row('clean-skill', 'clean', 1),
  row('pending-skill', 'pending', 2),
  row('flagged-skill', 'suspicious', 3),
  row('banned-skill', 'blocked', 4),
];

function memoryDb(rows: SkillRow[] = ROWS): DatabaseProvider {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    skills: {
      async list(opts?: { status?: string; scan_status?: string }) {
        return rows.filter(
          (r) =>
            (!opts?.status || r.status === opts.status) && (!opts?.scan_status || r.scan_status === opts.scan_status),
        );
      },
      async getByName(name: string) {
        return rows.find((r) => r.name === name);
      },
      async getVersion(skillId: number, version: string) {
        const skill = byId.get(skillId);
        if (!skill || skill.latest_version !== version) return undefined;
        return {
          id: skillId,
          skill_id: skillId,
          version,
          changelog: 'x',
          file_count: 1,
          size_bytes: 10,
          // Must be the real hash — downloadSkill verifies bundle integrity.
          content_hash: bundleContentHash(filesFor(skill.name)),
          storage_key: storageKeyFor(skill.name, version),
          created_by: 'u1',
          created_at: nowIso(),
        };
      },
      async incrementDownloads() {},
    },
  } as unknown as DatabaseProvider;
}

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'skills-sync-'));
  _setSkillStoreForTests(memoryStore());
  _resetSkillsSync();
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  _resetSkillStoreForTests();
  _resetSkillsSync();
  vi.restoreAllMocks();
});

describe('sandbox skills sync — quarantine predicate', () => {
  it('materializes only reviewed clean skills', async () => {
    await ensureSkillsSynced(memoryDb(), dataRoot);
    const present = readdirSync(skillsDirFor(dataRoot));
    expect(present.sort()).toEqual(['clean-skill']);
  });

  it('removes an already-materialized copy once its skill turns suspicious', async () => {
    // Pretend a previous pass wrote it while it was still clean.
    const dir = join(skillsDirFor(dataRoot), 'flagged-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# flagged-skill');
    writeFileSync(join(dir, '.version'), '1.0.0');

    await ensureSkillsSynced(memoryDb(), dataRoot);
    expect(existsSync(dir)).toBe(false);
  });

  it('fails closed when every row is still pending', async () => {
    const allPending = [row('a-skill', 'pending', 1), row('b-skill', 'pending', 2)];
    await ensureSkillsSynced(memoryDb(allPending), dataRoot);
    expect(readdirSync(skillsDirFor(dataRoot)).sort()).toEqual([]);
  });
});
