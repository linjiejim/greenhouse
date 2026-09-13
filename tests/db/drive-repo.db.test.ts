/**
 * Drive (云盘) repository integration tests.
 *
 * The drive subsystem is a generic folder/file cabinet shared by two scopes:
 *   - scope='kb'  → knowledge-base folders, keyed by visibility + owner_user_id
 *                   (this file's focus: a user's private tree)
 *   - scope='tables' → Base-owned folders/files, keyed by base_id
 *
 * Folders nest purely via parent_id (no materialized path); a folder move is
 * just a parent_id change and the subtree follows. Files have a pending→active
 * lifecycle so a presigned direct-upload that never completes is never listed.
 *
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

async function createUser(db: DatabaseProvider, email: string) {
  return db.users.create({ email, password_hash: 'h', nickname: email, role: 'team' });
}

/** Owner keys for a user's private knowledge tree. */
function privateKb(ownerId: string) {
  return { scope: 'kb' as const, visibility: 'private' as const, owner_user_id: ownerId };
}

describe('Drive — private knowledge folders', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it("creates a folder in the user's private tree and lists it at the root", async () => {
    const alice = await createUser(db, 'alice@test.com');

    const folder = await db.drive.createFolder({
      ...privateKb(alice.id),
      name: 'Contracts',
      created_by: alice.id,
    });

    expect(folder.id).toBeGreaterThan(0);
    expect(folder.scope).toBe('kb');
    expect(folder.visibility).toBe('private');
    expect(folder.owner_user_id).toBe(alice.id);
    expect(folder.parent_id).toBeNull();
    expect(folder.name).toBe('Contracts');

    const roots = await db.drive.listFolders({ ...privateKb(alice.id), parent_id: null });
    expect(roots.map((f) => f.name)).toEqual(['Contracts']);
  });
});

describe('Drive — file lifecycle', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('initFile creates a pending row that is not yet listed among active files', async () => {
    const alice = await createUser(db, 'alice@test.com');

    const file = await db.drive.initFile({
      ...privateKb(alice.id),
      folder_id: null,
      name: 'contract.pdf',
      cos_key: 'drive/kb/test/contract-abc123.pdf',
      content_type: 'application/pdf',
      size: 1234,
      uploaded_by: alice.id,
    });

    expect(file.id).toBeGreaterThan(0);
    expect(file.status).toBe('pending');
    expect(file.cos_key).toBe('drive/kb/test/contract-abc123.pdf');

    // A presigned upload that never completes must never surface in a listing.
    const listed = await db.drive.listFiles({ ...privateKb(alice.id), folder_id: null });
    expect(listed).toEqual([]);
  });

  it('completeFile flips pending → active and the file then lists with its verified size', async () => {
    const alice = await createUser(db, 'alice@test.com');

    const pending = await db.drive.initFile({
      ...privateKb(alice.id),
      folder_id: null,
      name: 'contract.pdf',
      cos_key: 'drive/kb/test/contract-def456.pdf',
      content_type: 'application/pdf',
      size: 0,
      uploaded_by: alice.id,
    });

    // Size is the HeadObject-verified actual size, not the client's claim.
    const done = await db.drive.completeFile(pending.id, { size: 2048 });
    expect(done?.status).toBe('active');
    expect(done?.size).toBe(2048);

    const listed = await db.drive.listFiles({ ...privateKb(alice.id), folder_id: null });
    expect(listed.map((f) => f.name)).toEqual(['contract.pdf']);
    expect(listed[0]!.size).toBe(2048);
  });

  it('getFile fetches by id; softDeleteFile removes it from listings but keeps the row', async () => {
    const alice = await createUser(db, 'alice@test.com');

    const file = await db.drive.initFile({
      ...privateKb(alice.id),
      folder_id: null,
      name: 'spec.pdf',
      cos_key: 'drive/kb/test/spec-ghi789.pdf',
      content_type: 'application/pdf',
      uploaded_by: alice.id,
    });
    await db.drive.completeFile(file.id, { size: 100 });

    const got = await db.drive.getFile(file.id);
    expect(got?.id).toBe(file.id);
    expect(got?.status).toBe('active');

    expect(await db.drive.softDeleteFile(file.id)).toBe(true);

    // Gone from listings…
    const listed = await db.drive.listFiles({ ...privateKb(alice.id), folder_id: null });
    expect(listed).toEqual([]);
    // …but the row survives, marked deleted, so the route can GC the COS object.
    const afterDelete = await db.drive.getFile(file.id);
    expect(afterDelete?.status).toBe('deleted');
  });
});

describe('Drive — Tables Base scope', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('isolates files by Base and enforces the scope-owner database check', async () => {
    const alice = await createUser(db, 'alice@test.com');
    const firstBase = await db.tables.createBase({
      name: 'First Base',
      owner_id: alice.id,
      created_by: alice.id,
    });
    const secondBase = await db.tables.createBase({
      name: 'Second Base',
      owner_id: alice.id,
      created_by: alice.id,
    });
    const folder = await db.drive.createFolder({
      scope: 'tables',
      base_id: firstBase.id,
      name: 'Briefs',
      created_by: alice.id,
    });
    const pending = await db.drive.initFile({
      scope: 'tables',
      base_id: firstBase.id,
      folder_id: folder.id,
      name: 'brief.pdf',
      cos_key: 'drive/tables/test/brief.pdf',
      uploaded_by: alice.id,
    });
    await db.drive.completeFile(pending.id, { size: 42 });

    expect(await db.drive.listFiles({ scope: 'tables', base_id: firstBase.id, folder_id: folder.id })).toEqual([
      expect.objectContaining({ id: pending.id, base_id: firstBase.id }),
    ]);
    expect(await db.drive.listFiles({ scope: 'tables', base_id: secondBase.id })).toEqual([]);
    await expect(
      db.drive.createFolder({ scope: 'tables', name: 'Missing Base', created_by: alice.id }),
    ).rejects.toThrow();
  });
});

describe('Drive — folder tree navigation', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('breadcrumb returns the ancestor chain from root down to the folder', async () => {
    const alice = await createUser(db, 'alice@test.com');

    const root = await db.drive.createFolder({
      ...privateKb(alice.id),
      name: 'Contracts',
      created_by: alice.id,
    });
    const child = await db.drive.createFolder({
      ...privateKb(alice.id),
      parent_id: root.id,
      name: '2024',
      created_by: alice.id,
    });
    const grand = await db.drive.createFolder({
      ...privateKb(alice.id),
      parent_id: child.id,
      name: 'Q1',
      created_by: alice.id,
    });

    const crumbs = await db.drive.breadcrumb(grand.id);
    expect(crumbs.map((f) => f.name)).toEqual(['Contracts', '2024', 'Q1']);

    // A move is just a parent_id change — listing a folder's children is one level deep.
    expect((await db.drive.listFolders({ ...privateKb(alice.id), parent_id: root.id })).map((f) => f.name)).toEqual([
      '2024',
    ]);
  });

  it('deleteFolder refuses a non-empty folder, then succeeds once emptied', async () => {
    const alice = await createUser(db, 'alice@test.com');

    const root = await db.drive.createFolder({
      ...privateKb(alice.id),
      name: 'docs',
      created_by: alice.id,
    });
    const file = await db.drive.initFile({
      ...privateKb(alice.id),
      folder_id: root.id,
      name: 'a.pdf',
      cos_key: 'drive/kb/test/a-jkl.pdf',
      uploaded_by: alice.id,
    });
    await db.drive.completeFile(file.id, { size: 1 });

    // Refuses while it still holds an active file.
    expect(await db.drive.deleteFolder(root.id)).toEqual({ ok: false, reason: 'not_empty' });

    await db.drive.softDeleteFile(file.id);

    // Empty now → deletes.
    expect(await db.drive.deleteFolder(root.id)).toEqual({ ok: true });
    expect(await db.drive.listFolders({ ...privateKb(alice.id), parent_id: null })).toEqual([]);
  });
});

describe('Drive — updateFolder (rename / move)', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  /** Three-level kb team tree: root → child → grandchild. */
  async function kbTree(ownerId: string) {
    const root = await db.drive.createFolder({ scope: 'kb', visibility: 'team', name: 'root', created_by: ownerId });
    const child = await db.drive.createFolder({
      scope: 'kb',
      visibility: 'team',
      parent_id: root.id,
      name: 'child',
      created_by: ownerId,
    });
    const grand = await db.drive.createFolder({
      scope: 'kb',
      visibility: 'team',
      parent_id: child.id,
      name: 'grand',
      created_by: ownerId,
    });
    return { root, child, grand };
  }

  it('renames a folder without touching its place in the tree', async () => {
    const alice = await createUser(db, 'alice@test.com');
    const { root, child } = await kbTree(alice.id);

    const res = await db.drive.updateFolder(child.id, { name: 'Brand guidelines' });
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) throw new Error('unreachable');
    expect(res.folder.name).toBe('Brand guidelines');
    expect(res.folder.parent_id).toBe(root.id);
  });

  it('moves a folder to another parent and to the root, carrying its subtree', async () => {
    const alice = await createUser(db, 'alice@test.com');
    const { root, child, grand } = await kbTree(alice.id);

    // child (with grand under it) → root's sibling level.
    expect(await db.drive.updateFolder(child.id, { parent_id: null })).toMatchObject({ ok: true });
    const roots = await db.drive.listFolders({ scope: 'kb', visibility: 'team', parent_id: null });
    expect(roots.map((f) => f.name).sort()).toEqual(['child', 'root']);
    // The subtree followed: grand is still under child.
    expect(await db.drive.breadcrumb(grand.id)).toMatchObject([{ id: child.id }, { id: grand.id }]);

    // …and back under root.
    expect(await db.drive.updateFolder(child.id, { parent_id: root.id })).toMatchObject({ ok: true });
    expect(await db.drive.breadcrumb(grand.id)).toMatchObject([{ id: root.id }, { id: child.id }, { id: grand.id }]);
  });

  it('refuses to move a folder into itself or its own descendant', async () => {
    const alice = await createUser(db, 'alice@test.com');
    const { root, child, grand } = await kbTree(alice.id);

    expect(await db.drive.updateFolder(root.id, { parent_id: root.id })).toEqual({ ok: false, reason: 'cycle' });
    expect(await db.drive.updateFolder(root.id, { parent_id: child.id })).toEqual({ ok: false, reason: 'cycle' });
    expect(await db.drive.updateFolder(root.id, { parent_id: grand.id })).toEqual({ ok: false, reason: 'cycle' });

    // Nothing moved.
    expect(await db.drive.breadcrumb(grand.id)).toMatchObject([{ id: root.id }, { id: child.id }, { id: grand.id }]);
  });

  it('reports not_found for an unknown folder or parent', async () => {
    const alice = await createUser(db, 'alice@test.com');
    const { child } = await kbTree(alice.id);

    expect(await db.drive.updateFolder(999_999, { name: 'x' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await db.drive.updateFolder(child.id, { parent_id: 999_999 })).toEqual({ ok: false, reason: 'not_found' });
  });
});
