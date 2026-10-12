/**
 * @db-commit-reason First visits can race across API processes. Independent committed
 * transactions must still return one main Agent even when their name snapshots differ.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { ensureSproutyBot } from '../sprouty.js';

let db: DatabaseProvider;
let userId: string;
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  userId = (
    await db.users.create({
      email: `sprouty-race-${randomUUID()}@greenhouse.local`,
      password_hash: 'x',
      nickname: 'Race',
      role: 'team',
    })
  ).id;
});
afterEach(async () => {
  await db.users.delete(userId);
  await db.close();
  _resetProvider();
});

it('creates one main Agent across different concurrent name snapshots and later first visits', async () => {
  const results = await Promise.all(
    ['Sprouty', 'Sprouty 2'].map((name) =>
      db.bots.createBot({ user_id: userId, name, template_key: 'sprouty', builtIn: true }),
    ),
  );
  expect(new Set(results.map((bot) => bot.id)).size).toBe(1);
  await db.bots.updateBot(userId, results[0]!.id, { name: 'My assistant' });
  const visits = await Promise.all(Array.from({ length: 5 }, () => ensureSproutyBot(db, userId)));
  expect(visits.every((bot) => bot.id === results[0]!.id && bot.name === 'My assistant')).toBe(true);
  expect((await db.bots.listBots(userId)).filter((bot) => bot.template_key === 'sprouty')).toHaveLength(1);
});
