/**
 * `memory` recall through the real tool on PostgreSQL (spec 20261009 D7):
 * words of a query no longer need to be adjacent, the best match comes first,
 * and recall keeps its scope and status rules.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { createMemoryTool } from '../memory.js';

let db: DatabaseProvider;
let user: UserRow;

async function recall(query: string): Promise<Array<{ id: number; title: string }>> {
  const tool = createMemoryTool(db, { userId: user.id }) as unknown as {
    execute: (input: unknown, options: unknown) => Promise<{ memories?: Array<{ id: number; title: string }> }>;
  };
  return (await tool.execute({ action: 'recall', query }, {})).memories ?? [];
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: `mem-recall-${Date.now()}-${Math.random()}@test.local` });
  const base = { user_id: user.id, category: 'preference' as const, source: 'agent' as const };
  await db.userMemories.create({
    ...base,
    title: 'Prefers CRM figures broken down by 客户类型',
    content: 'When reporting CRM numbers, group by 客户类型 rather than by country.',
  });
  await db.userMemories.create({ ...base, title: '周报格式偏好', content: '周报先写结论，再列数据；表格不超过五列。' });
  await db.userMemories.create({ ...base, title: 'Timezone', content: 'Lives in Shanghai (UTC+8).' });
});

describe('memory recall', () => {
  it('finds a memory from words that are not adjacent in it (ILIKE needed the whole phrase)', async () => {
    const found = await recall('CRM 客户类型 报表');
    expect(found[0]?.title).toBe('Prefers CRM figures broken down by 客户类型');
  });

  it('matches Chinese words inside a longer title', async () => {
    expect((await recall('周报 格式')).map((m) => m.title)).toEqual(['周报格式偏好']);
  });

  it('answers empty instead of the newest memories when nothing matches', async () => {
    expect(await recall('kubernetes ingress')).toEqual([]);
  });

  it('never returns an archived memory unless asked', async () => {
    const archived = await db.userMemories.create({
      user_id: user.id,
      category: 'fact',
      source: 'agent',
      title: 'Old CRM export path',
      content: 'CRM exports used to land in /tmp/crm',
    });
    await db.userMemories.setStatus(archived.id, user.id, 'archived');
    expect((await recall('CRM export path')).map((m) => m.id)).not.toContain(archived.id);
  });
});
