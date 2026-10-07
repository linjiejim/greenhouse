/**
 * Bot creation concurrency integration tests.
 *
 * @db-commit-reason Two connections must contend on `uq_bots_user_name_active`
 * (the rollback-transaction suite runs every call on one connection, where the
 * second insert never blocks on the first's uncommitted row).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetProvider, BotsDomainError, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { ensureSproutyBot } from '../../apps/api/src/bots/sprouty.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
const createdUserIds: string[] = [];

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('Bot creation concurrency', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    for (const userId of createdUserIds) await db.users.delete(userId); // bots cascade
    await db.close();
    _resetProvider();
  });

  it('turns the losing duplicate insert into the domain error instead of a raw unique violation', async () => {
    const owner = await createInternalTestUser(db, { email: `${unique('bot-race')}@test.local` });
    createdUserIds.push(owner.id);
    // Both pre-checks pass before either insert commits; the unique index decides.
    const input = { user_id: owner.id, name: unique('Twin').slice(0, 24), role: 'twin', instructions: 'x' };
    const results = await Promise.allSettled([db.bots.createBot(input), db.bots.createBot(input)]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(BotsDomainError);
    expect((rejected[0]!.reason as BotsDomainError).code).toBe('bot_name_taken');
    expect(await db.bots.listBots(owner.id)).toHaveLength(1);
  });

  it('bootstraps one Sprouty when Chat and the Bots page race on a member\'s first visit', async () => {
    const member = await createInternalTestUser(db, { email: `${unique('sprouty-race')}@test.local` });
    createdUserIds.push(member.id);
    const [a, b] = await Promise.all([ensureSproutyBot(db, member.id), ensureSproutyBot(db, member.id)]);
    expect(a.id).toBe(b.id);
    expect((await db.bots.listBots(member.id)).filter((bot) => bot.template_key === 'sprouty')).toHaveLength(1);
  });
});
