import { services as tableServices } from '../services.js';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { initDatabase, _resetProvider, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
let db: DatabaseProvider;
async function createUser(db: DatabaseProvider, email: string) {
  return db.users.create({ email, password_hash: 'h', nickname: email, role: 'team' });
}
describe('Drive — Tables Base scope', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('isolates files by Base and enforces the registered scope placement rule', async () => {
    const alice = await createUser(db, 'alice@test.com');
    const firstBase = await tableServices(db).tables.createBase({
      name: 'First Base',
      owner_id: alice.id,
      created_by: alice.id,
    });
    const secondBase = await tableServices(db).tables.createBase({
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
