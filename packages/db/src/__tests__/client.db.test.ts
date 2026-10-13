import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, transaction } from '../client.js';
import { newId } from '../ids.js';
import { members } from '../schema/index.js';

describe('transaction', () => {
  it('makes getDb() return the open transaction, so nested reads see its writes', async () => {
    const id = newId('member');
    await transaction(async (db) => {
      expect(getDb()).toBe(db);
      await db.insert(members).values({ id, email: `${id}@example.com`, name: 'Lin' });
      const [seen] = await getDb().select({ id: members.id }).from(members).where(eq(members.id, id));
      expect(seen?.id).toBe(id);
    });
  });

  it('rolls back only the failed inner transaction', async () => {
    const kept = newId('member');
    const dropped = newId('member');
    await transaction(async (db) => {
      await db.insert(members).values({ id: kept, email: `${kept}@example.com`, name: 'Kept' });
      await expect(
        transaction(async (inner) => {
          await inner.insert(members).values({ id: dropped, email: `${dropped}@example.com`, name: 'Dropped' });
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');
    });
    const rows = await getDb().select({ id: members.id }).from(members);
    expect(rows.map((row) => row.id)).toContain(kept);
    expect(rows.map((row) => row.id)).not.toContain(dropped);
  });
});
