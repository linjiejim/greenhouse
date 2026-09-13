/**
 * Skill Center service integration tests (real PostgreSQL).
 *
 * Covers the catalog + immutable version-history invariants the Skill Center
 * builds on: create-with-first-version, monotonic latest_version denorm,
 * the (skill_id, version) uniqueness guard, search, and cascade delete.
 *
 * Requires: PostgreSQL at localhost:5432 with the greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

function versionInput(version: string, changelog = 'Initial release') {
  return {
    version,
    changelog,
    file_count: 2,
    size_bytes: 1234,
    content_hash: `hash-${version}`,
    storage_key: `skills/pdf-report/${version}.json`,
    created_by: 'u1',
  };
}

describe('Skill service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('create inserts the catalog row and its first version atomically', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'Render PDF reports', tags: ['pdf', 'report'], owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    expect(skill.display_name).toBe('pdf-report'); // defaults to name
    expect(skill.latest_version).toBe('0.1.0');
    expect(skill.status).toBe('active');

    const versions = await db.skills.listVersions(skill.id);
    expect(versions.map((v) => v.version)).toEqual(['0.1.0']);
    expect(versions[0]!.changelog).toBe('Initial release');
  });

  it('addVersion appends history and bumps latest_version', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    await db.skills.addVersion(skill.id, versionInput('0.2.0', 'Add landscape mode'));

    const reloaded = await db.skills.getByName('pdf-report');
    expect(reloaded!.latest_version).toBe('0.2.0');

    const versions = await db.skills.listVersions(skill.id);
    expect(versions.map((v) => v.version)).toEqual(['0.2.0', '0.1.0']); // newest first
    expect(versions[0]!.changelog).toBe('Add landscape mode');
  });

  it('rejects republishing an existing version number (unique guard)', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    await expect(db.skills.addVersion(skill.id, versionInput('0.1.0', 'dup'))).rejects.toThrow();
    // The failed transaction must not have touched latest_version.
    expect((await db.skills.getById(skill.id))!.latest_version).toBe('0.1.0');
  });

  it('rejects a duplicate skill name', async () => {
    await db.skills.create({ name: 'pdf-report', description: 'x', owner_user_id: 'u1' }, versionInput('0.1.0'));
    await expect(
      db.skills.create({ name: 'pdf-report', description: 'y', owner_user_id: 'u2' }, versionInput('1.0.0')),
    ).rejects.toThrow();
  });

  it('list searches name/display_name/description/tags and filters status', async () => {
    await db.skills.create(
      { name: 'pdf-report', display_name: 'PDF Report', description: 'render pdfs', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    const excel = await db.skills.create(
      { name: 'excel-export', description: 'spreadsheet export', tags: ['excel'], owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );

    expect((await db.skills.list({ q: 'pdf' })).map((s) => s.name)).toEqual(['pdf-report']);
    expect((await db.skills.list({ q: 'spreadsheet' })).map((s) => s.name)).toEqual(['excel-export']);
    expect((await db.skills.list({ q: 'excel' })).map((s) => s.name)).toEqual(['excel-export']); // tag hit
    expect(await db.skills.count({})).toBe(2);

    await db.skills.setStatus(excel.id, 'archived');
    expect((await db.skills.list({ status: 'active' })).map((s) => s.name)).toEqual(['pdf-report']);
    expect(await db.skills.count({ status: 'archived' })).toBe(1);
  });

  it('updateMeta changes display/description/tags but never name', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    const updated = await db.skills.updateMeta(skill.id, { description: 'better', tags: ['a', 'b'] });
    expect(updated!.description).toBe('better');
    expect(JSON.parse(updated!.tags)).toEqual(['a', 'b']);
    expect(updated!.name).toBe('pdf-report');
  });

  it('incrementDownloads counts up', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    await db.skills.incrementDownloads(skill.id);
    await db.skills.incrementDownloads(skill.id);
    expect((await db.skills.getById(skill.id))!.download_count).toBe(2);
  });

  it('new rows default to an unscanned pending verdict', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    expect(skill.scan_status).toBe('pending');
    expect(skill.scan_findings).toBe('[]');
    expect(skill.scan_version).toBeNull();
    expect(skill.scanned_at).toBeNull();
    expect(skill.scan_reviewed_by).toBeNull();
  });

  it('setScanResult persists the verdict and findings without reordering the catalog', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    const findings = [{ rule: 'remote-script-execution', severity: 'high', path: 'SKILL.md', excerpt: 'curl … | sh' }];
    const updated = await db.skills.setScanResult(skill.id, {
      status: 'suspicious',
      findings,
      version: '0.1.0',
    });
    expect(updated!.scan_status).toBe('suspicious');
    expect(JSON.parse(updated!.scan_findings)).toEqual(findings);
    expect(updated!.scan_version).toBe('0.1.0');
    expect(updated!.scanned_at).not.toBeNull();
    // updated_at orders the catalog — a background rescan must not reshuffle it.
    expect(updated!.updated_at).toBe(skill.updated_at);
  });

  it('setScanDecision records the reviewer, and a later scan supersedes the ruling', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    await db.skills.setScanResult(skill.id, { status: 'suspicious', findings: [], version: '0.1.0' });
    const decided = await db.skills.setScanDecision(skill.id, {
      status: 'blocked',
      reviewed_by: 'u-admin',
      note: 'confirmed malicious',
    });
    expect(decided).toMatchObject({
      scan_status: 'blocked',
      scan_reviewed_by: 'u-admin',
      scan_note: 'confirmed malicious',
    });
    expect(decided!.scan_reviewed_at).not.toBeNull();

    const rescanned = await db.skills.setScanResult(skill.id, { status: 'clean', findings: [], version: '0.2.0' });
    expect(rescanned!.scan_reviewed_by).toBeNull();
    expect(rescanned!.scan_note).toBeNull();
  });

  it('list/count filter by scan_status, and listUnscanned finds never-scanned rows', async () => {
    const clean = await db.skills.create(
      { name: 'clean-skill', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    const flagged = await db.skills.create(
      { name: 'flagged-skill', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    const untouched = await db.skills.create(
      { name: 'untouched-skill', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    await db.skills.setScanResult(clean.id, { status: 'clean', findings: [], version: '0.1.0' });
    await db.skills.setScanResult(flagged.id, { status: 'suspicious', findings: [], version: '0.1.0' });

    const suspicious = await db.skills.list({ scan_status: 'suspicious' });
    expect(suspicious.map((s) => s.name)).toContain('flagged-skill');
    expect(suspicious.map((s) => s.name)).not.toContain('clean-skill');
    expect(await db.skills.count({ scan_status: 'suspicious' })).toBe(suspicious.length);

    const unscanned = await db.skills.listUnscanned(50);
    expect(unscanned.map((s) => s.id)).toContain(untouched.id);
    expect(unscanned.map((s) => s.id)).not.toContain(clean.id);
  });

  it('onlyIfLatestVersion drops a stale verdict instead of clearing a newer quarantine', async () => {
    // The concurrent-publish guard. Two publishes of the same skill race; the
    // older bundle's scan finishes last. Without the version predicate its
    // `clean` verdict lands on top and clears the quarantine the newer, higher
    // version just earned — a fail-open that reopens download for a bundle the
    // scanner rejected.
    const skill = await db.skills.create(
      { name: 'racy-skill', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    await db.skills.addVersion(skill.id, versionInput('0.2.0', 'newer bundle'));
    await db.skills.setScanResult(skill.id, {
      status: 'suspicious',
      findings: [{ rule: 'exec-magic-bytes', severity: 'high', file: 'run.sh', detail: 'ELF header' }],
      version: '0.2.0',
      onlyIfLatestVersion: '0.2.0',
    });

    // The 0.1.0 scan reports late, guarded on the version it actually scanned.
    const stale = await db.skills.setScanResult(skill.id, {
      status: 'clean',
      findings: [],
      version: '0.1.0',
      onlyIfLatestVersion: '0.1.0',
    });

    expect(stale!.scan_status).toBe('suspicious');
    expect(stale!.scan_version).toBe('0.2.0');
    expect(JSON.parse(stale!.scan_findings)).toHaveLength(1);

    // …and the guard is a predicate, not a blanket refusal: a verdict for the
    // version that is actually current still applies.
    const current = await db.skills.setScanResult(skill.id, {
      status: 'clean',
      findings: [],
      version: '0.2.0',
      onlyIfLatestVersion: '0.2.0',
    });
    expect(current!.scan_status).toBe('clean');
  });

  it('remove hard-deletes the skill and cascades its versions', async () => {
    const skill = await db.skills.create(
      { name: 'pdf-report', description: 'x', owner_user_id: 'u1' },
      versionInput('0.1.0'),
    );
    expect(await db.skills.remove(skill.id)).toBe(true);
    expect(await db.skills.getByName('pdf-report')).toBeUndefined();
    expect(await db.skills.getVersion(skill.id, '0.1.0')).toBeUndefined();
    expect(await db.skills.remove(skill.id)).toBe(false); // already gone
  });
});
