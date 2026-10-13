import { describe, expect, it } from 'vitest';
import { getDb, type Db } from '../client.js';
import { newId } from '../ids.js';
import { agents, conversations, members, shares } from '../schema/index.js';

async function member(db: Db = getDb()) {
  const [row] = await db
    .insert(members)
    .values({ id: newId('member'), email: `${newId('member')}@example.com`, name: 'Lin', status: 'active' })
    .returning();
  return row!;
}

async function agent(ownerId: string, name: string, isMain = false, db: Db = getDb()) {
  const [row] = await db
    .insert(agents)
    .values({ id: newId('agent'), ownerId, name, nameKey: name.toLowerCase(), isMain })
    .returning();
  return row!;
}

/** A failing statement aborts the test transaction, so expected violations run in a savepoint. */
function inSavepoint<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return getDb().transaction((sp) => fn(sp as unknown as Db));
}

describe('v2 baseline constraints', () => {
  it('allows one main Agent per member and unique names among live Agents', async () => {
    const owner = await member();
    await agent(owner.id, 'Greeny', true);
    await expect(inSavepoint((db) => agent(owner.id, 'Second', true, db))).rejects.toThrow();
    await agent(owner.id, 'Weekly');
    await expect(inSavepoint((db) => agent(owner.id, 'weekly', false, db))).rejects.toThrow();
  });

  it('allows one main conversation per member', async () => {
    const owner = await member();
    const main = await agent(owner.id, 'Greeny', true);
    const values = { ownerId: owner.id, agentId: main.id, kind: 'main' as const };
    await getDb()
      .insert(conversations)
      .values({ id: newId('conversation'), ...values });
    await expect(
      inSavepoint((db) => db.insert(conversations).values({ id: newId('conversation'), ...values })),
    ).rejects.toThrow();
  });

  it('treats a workspace-wide share as one grant even though its principal id is null', async () => {
    const grant = {
      resourceType: 'doc' as const,
      resourceId: 'doc_1',
      principalType: 'workspace' as const,
      role: 'viewer',
    };
    await getDb()
      .insert(shares)
      .values({ id: newId('share'), ...grant });
    await expect(inSavepoint((db) => db.insert(shares).values({ id: newId('share'), ...grant }))).rejects.toThrow();
  });

  it('defaults new members to invited members with empty modules', async () => {
    const [row] = await getDb()
      .insert(members)
      .values({ id: newId('member'), email: 'new@example.com', name: 'New' })
      .returning();
    expect(row).toMatchObject({ role: 'member', status: 'invited', authVersion: 0, modules: {} });
  });
});
