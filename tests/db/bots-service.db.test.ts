/**
 * Bots service — who leads a group. `lead_bot_id` (the floor controller's
 * "who answers unaddressed messages") and the member roles (what every Bot's
 * roster says) must always agree, through a lead change, a lead leaving and a
 * lead being archived; a DM keeps its owner/guest roles whatever happens.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

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

describe('group lead', () => {
  it('a lead change moves the lead role with it', async () => {
    const [ivy, sage, fern] = [await bot('Ivy'), await bot('Sage'), await bot('Fern')];
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, sage.id, fern.id] });
    await db.bots.updateConversation(user.id, group.session_id, { lead_bot_id: fern.id });
    expect(await leadState(group.session_id)).toEqual({
      lead: fern.id,
      roles: [
        [ivy.id, 'member'],
        [sage.id, 'member'],
        [fern.id, 'lead'],
      ],
    });
  });

  it('archiving the lead hands the lead to the next active member by position', async () => {
    const [ivy, sage, fern] = [await bot('Ivy'), await bot('Sage'), await bot('Fern')];
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, sage.id, fern.id] });
    expect(await db.bots.archiveBot(user.id, ivy.id)).toBe(true);
    expect(await leadState(group.session_id)).toEqual({
      lead: sage.id,
      roles: [
        [sage.id, 'lead'],
        [fern.id, 'member'],
      ],
    });
  });

  it('archiving a non-lead leaves the lead alone', async () => {
    const [ivy, sage] = [await bot('Ivy'), await bot('Sage')];
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, sage.id] });
    await db.bots.archiveBot(user.id, sage.id);
    expect(await leadState(group.session_id)).toEqual({ lead: ivy.id, roles: [[ivy.id, 'lead']] });
  });

  it('archiving the last member leaves the group without a lead', async () => {
    const [ivy, sage] = [await bot('Ivy'), await bot('Sage')];
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, sage.id] });
    await db.bots.archiveBot(user.id, ivy.id);
    await db.bots.archiveBot(user.id, sage.id);
    expect(await leadState(group.session_id)).toEqual({ lead: null, roles: [] });
  });

  it('removing the lead promotes the next member by position', async () => {
    const [ivy, sage, fern] = [await bot('Ivy'), await bot('Sage'), await bot('Fern')];
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, sage.id, fern.id] });
    await db.bots.updateConversation(user.id, group.session_id, { lead_bot_id: sage.id });
    expect(await db.bots.removeMember(user.id, group.session_id, sage.id)).toBe(true);
    expect(await leadState(group.session_id)).toEqual({
      lead: ivy.id,
      roles: [
        [ivy.id, 'lead'],
        [fern.id, 'member'],
      ],
    });
  });

  it('removing a non-lead keeps the lead and its role', async () => {
    const [ivy, sage] = [await bot('Ivy'), await bot('Sage')];
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, sage.id] });
    await db.bots.removeMember(user.id, group.session_id, sage.id);
    expect(await leadState(group.session_id)).toEqual({ lead: ivy.id, roles: [[ivy.id, 'lead']] });
  });
});

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
