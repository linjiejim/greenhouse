/**
 * Bots conversations and Bot background-task children never show up in the
 * generic session surfaces (Chat history, title search, session_query list)
 * unless a caller asks for that channel explicitly — the one hide-by-default
 * filter (`defaultSessionListHiding`) and the one task prefix
 * (`BOT_TASK_SESSION_PREFIX`) every surface shares.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import {
  BOT_TASK_SESSION_PREFIX,
  defaultSessionListHiding,
  HIDDEN_SESSION_ID_PREFIXES,
} from '@greenhouse/types/session';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { BOT_TASK_SESSION_PREFIX as ENGINE_PREFIX } from '../engine/tasks.js';

let db: DatabaseProvider;
let user: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: `hidden-${Date.now()}-${Math.random()}@test.local` });
});

describe('hidden sessions', () => {
  it('one task prefix everywhere', () => {
    expect(ENGINE_PREFIX).toBe(BOT_TASK_SESSION_PREFIX);
    expect(HIDDEN_SESSION_ID_PREFIXES).toContain(BOT_TASK_SESSION_PREFIX);
    expect(defaultSessionListHiding('bots')).toEqual({});
  });

  it('lists and title search hide Bots conversations and task children by default only', async () => {
    const web = await db.sessions.create('Quarterly plan', 'sprouty', user.id, undefined, 'web');
    const bots = await db.sessions.create('Quarterly plan with Ivy', 'sprouty', user.id, undefined, 'bots');
    const task = await db.sessions.create('Quarterly plan task', 'sprouty', user.id, undefined, 'subagent', bots.id, {
      id: `${BOT_TASK_SESSION_PREFIX}${'a'.repeat(40)}`,
    });

    const listed = await db.sessions.list({ userId: user.id, ...defaultSessionListHiding() });
    expect(listed.map((s) => s.id)).toEqual([web.id]);
    expect((await db.sessions.searchByTitle(user.id, 'Quarterly')).map((s) => s.id)).toEqual([web.id]);

    expect((await db.sessions.searchByTitle(user.id, 'Quarterly', 10, 'bots')).map((s) => s.id)).toEqual([bots.id]);
    const subagents = await db.sessions.list({
      userId: user.id,
      channel: 'subagent',
      ...defaultSessionListHiding('subagent'),
    });
    expect(subagents.map((s) => s.id)).toEqual([task.id]);
  });

  it('hides id prefixes literally — LIKE metacharacters in a prefix or a title query match only themselves', async () => {
    const tag = Math.random().toString(16).slice(2, 10);
    const underscored = await db.sessions.create('Plan', 'sprouty', user.id, undefined, 'web', undefined, {
      id: `pfx_${tag}-1`,
    });
    // `_` as a wildcard would hide this one too.
    const lookalike = await db.sessions.create('Plan', 'sprouty', user.id, undefined, 'web', undefined, {
      id: `pfxX${tag}-2`,
    });
    const listed = await db.sessions.list({ userId: user.id, excludeIdPrefixes: [`pfx_${tag}`] });
    expect(listed.map((s) => s.id)).toContain(lookalike.id);
    expect(listed.map((s) => s.id)).not.toContain(underscored.id);
    // The member-deletion purge selects by prefix too — a wildcard there would delete the lookalike.
    const leaving = await db.sessions.listIdsLeavingWithOwner(user.id, { channels: [], idPrefixes: [`pfx_${tag}`] });
    expect(leaving).toEqual([underscored.id]);

    const percent = await db.sessions.create('100% done', 'sprouty', user.id, undefined, 'web');
    const plain = await db.sessions.create('1000 done', 'sprouty', user.id, undefined, 'web');
    const slashed = await db.sessions.create('C:\\work notes', 'sprouty', user.id, undefined, 'web');
    expect((await db.sessions.searchByTitle(user.id, '100%')).map((s) => s.id)).toEqual([percent.id]);
    expect((await db.sessions.searchByTitle(user.id, '00 d')).map((s) => s.id)).toEqual([plain.id]);
    expect((await db.sessions.searchByTitle(user.id, 'C:\\w')).map((s) => s.id)).toEqual([slashed.id]);
  });
});
