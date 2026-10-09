/**
 * Bots service — conversation membership. A DM keeps its owner/guest roles
 * whatever happens (an invited Bot is always a guest; archiving the owner
 * leaves no lead). Group chats are retired: an old group takes no invites or
 * removals (`group_closed`), and archiving one of its Bots re-appoints nobody.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  BotsDomainError,
  initDatabase,
  type BotRow,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { insertLegacyGroup } from '../../apps/api/src/bots/__tests__/helpers/legacy-group.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: `bots-service-${Date.now()}-${Math.random()}@test.local` });
});

afterEach(() => {
  _resetProvider();
});

async function bot(name: string): Promise<BotRow> {
  return db.bots.createBot({ user_id: user.id, name });
}

/** Lead id plus every member's role, in roster order. */
async function leadState(sessionId: string) {
  const conversation = (await db.bots.getConversation(user.id, sessionId))!;
  return {
    lead: conversation.lead_bot_id,
    roles: conversation.members.map((member) => [member.bot_id, member.role] as const),
  };
}

describe('direct conversation roles', () => {
  it('archiving the owner keeps owner/guest roles and leaves no lead', async () => {
    const [ivy, sage] = [await bot('Ivy'), await bot('Sage')];
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await db.bots.addMember(user.id, dm.session_id, sage.id, 'user');
    await db.bots.archiveBot(user.id, ivy.id);
    expect(await leadState(dm.session_id)).toEqual({
      lead: null,
      roles: [
        [ivy.id, 'owner'],
        [sage.id, 'guest'],
      ],
    });
  });

  it('archiving a guest leaves the DM led by its owner', async () => {
    const [ivy, sage] = [await bot('Ivy'), await bot('Sage')];
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await db.bots.addMember(user.id, dm.session_id, sage.id, 'user');
    await db.bots.archiveBot(user.id, sage.id);
    expect(await leadState(dm.session_id)).toEqual({ lead: ivy.id, roles: [[ivy.id, 'owner']] });
  });
});

describe('an invited Bot is a guest', () => {
  it('whoever invites it — the member or a Bot (team.add)', async () => {
    const [ivy, sage, fern] = [await bot('Ivy'), await bot('Sage'), await bot('Fern')];
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await db.bots.addMember(user.id, dm.session_id, sage.id, 'user');
    await db.bots.addMember(user.id, dm.session_id, fern.id, `bot:${ivy.id}`);
    const conversation = (await db.bots.getConversation(user.id, dm.session_id))!;
    expect(conversation.members.map((m) => [m.bot_id, m.role, m.added_by])).toEqual([
      [ivy.id, 'owner', 'user'],
      [sage.id, 'guest', 'user'],
      [fern.id, 'guest', `bot:${ivy.id}`],
    ]);
    expect(conversation.lead_bot_id).toBe(ivy.id);
    expect(await db.bots.removeMember(user.id, dm.session_id, fern.id)).toBe(true);
  });
});

describe('a retired group chat', () => {
  async function closedCode(work: Promise<unknown>): Promise<string | null> {
    try {
      await work;
      return null;
    } catch (error) {
      if (error instanceof BotsDomainError) return error.code;
      throw error;
    }
  }

  it('takes no invites or removals', async () => {
    const [ivy, sage, fern] = [await bot('Ivy'), await bot('Sage'), await bot('Fern')];
    const groupId = await insertLegacyGroup(db, { userId: user.id, botIds: [ivy.id, sage.id] });
    expect(await closedCode(db.bots.addMember(user.id, groupId, fern.id, 'user'))).toBe('group_closed');
    expect(await closedCode(db.bots.addMember(user.id, groupId, fern.id, `bot:${ivy.id}`))).toBe('group_closed');
    expect(await closedCode(db.bots.removeMember(user.id, groupId, sage.id))).toBe('group_closed');
    expect(await leadState(groupId)).toEqual({
      lead: ivy.id,
      roles: [
        [ivy.id, 'lead'],
        [sage.id, 'member'],
      ],
    });
  });

  it('archiving its old lead takes it off the roster and appoints nobody', async () => {
    const [ivy, sage] = [await bot('Ivy'), await bot('Sage')];
    const groupId = await insertLegacyGroup(db, { userId: user.id, botIds: [ivy.id, sage.id] });
    expect(await db.bots.archiveBot(user.id, ivy.id)).toBe(true);
    expect(await leadState(groupId)).toEqual({ lead: null, roles: [[sage.id, 'member']] });
  });
});
