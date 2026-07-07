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

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
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
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
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
