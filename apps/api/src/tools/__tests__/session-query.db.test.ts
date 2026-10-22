/**
 * session_query search over message content (real PostgreSQL).
 *
 * `search` now matches message text as well as titles, and
 * `conversation_search` reads back details the rolling digest folded away.
 * Both keep the tool's existing access rule exactly: search only ever covers
 * the caller's OWN sessions (even for super, as title search always did), and
 * reading inside a session needs ownership or the super role — a share grants
 * inbox access, not tool reach.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createSessionQueryTool } from '../session-query.js';

let db: DatabaseProvider;

async function execute(tool: unknown, input: unknown): Promise<Record<string, unknown>> {
  const executable = tool as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return (await executable.execute(input, { toolCallId: 'session-query-test', messages: [] })) as Record<
    string,
    unknown
  >;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sessionWith(userId: string, title: string, contents: string[]): Promise<string> {
  const session = await db.sessions.create(title, 'team', userId);
  for (const [i, content] of contents.entries()) {
    await db.sessions.addMessage({ session_id: session.id, role: i % 2 === 0 ? 'user' : 'assistant', content });
  }
  return session.id;
}

describe('session_query content search', () => {
  let alice: string;
  let bob: string;
  let marker: string;
  let aliceTitled: string;
  let aliceContent: string;
  let bobSession: string;

  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    alice = uid('alice');
    bob = uid('bob');
    marker = `quokka${Math.random().toString(36).slice(2, 8)}`;
    aliceTitled = await sessionWith(alice, `About ${marker}`, ['hello', 'hi']);
    aliceContent = await sessionWith(alice, 'Budget review', [
      'Which supplier did we pick?',
      `We picked ${marker} Ltd for the 蓝色方案, budget 1.2M.`,
    ]);
    bobSession = await sessionWith(bob, 'Private', [`${marker} is my secret`, 'noted']);
    await db.sessionShares.createMany([{ session_id: bobSession, shared_by: bob, shared_with: alice }]);
  });

  it('search finds title matches first, then the caller’s own conversations by message text', async () => {
    const tool = createSessionQueryTool(db, { userId: alice, userRole: 'team' });
    const result = await execute(tool, { action: 'search', query: marker });
    const sessions = result.sessions as Array<{ id: string; match?: { seq: number; snippet: string } }>;

    expect(sessions.map((s) => s.id)).toEqual([aliceTitled, aliceContent]);
    expect(sessions[0]!.match).toBeUndefined();
    expect(sessions[1]!.match).toMatchObject({ seq: 1 });
    expect(sessions[1]!.match!.snippet).toContain(marker);
  });

  it('search never reaches someone else’s session — not even one shared with the caller, not even for super', async () => {
    for (const role of ['team', 'super']) {
      const tool = createSessionQueryTool(db, { userId: alice, userRole: role });
      const result = await execute(tool, { action: 'search', query: `${marker} secret` });
      const ids = (result.sessions as Array<{ id: string }>).map((s) => s.id);
      expect(ids).not.toContain(bobSession);
    }
  });

  it('conversation_search defaults to the current conversation and returns seq-addressed snippets', async () => {
    const tool = createSessionQueryTool(db, { userId: alice, userRole: 'team', sessionId: aliceContent });
    const result = await execute(tool, { action: 'conversation_search', query: '蓝色方案 budget' });

    expect(result).toMatchObject({ session_id: aliceContent, found: 1 });
    const [match] = result.matches as Array<{ seq: number; role: string; snippet: string }>;
    expect(match).toMatchObject({ seq: 1, role: 'assistant' });
    expect(match!.snippet).toContain('1.2M');
  });

  it('conversation_search on another user’s session is denied for team and allowed for super', async () => {
    const teamTool = createSessionQueryTool(db, { userId: alice, userRole: 'team', sessionId: aliceContent });
    expect(await execute(teamTool, { action: 'conversation_search', query: marker, session_id: bobSession })).toEqual({
      error: 'Access denied — you can only read your own sessions',
    });

    const superTool = createSessionQueryTool(db, { userId: alice, userRole: 'super' });
    const result = await execute(superTool, { action: 'conversation_search', query: marker, session_id: bobSession });
    expect(result).toMatchObject({ session_id: bobSession, found: 1 });
  });

  it('conversation_search outside a conversation (proxy / MCP) needs an explicit session_id', async () => {
    const tool = createSessionQueryTool(db, { userId: alice, userRole: 'team' });
    expect(await execute(tool, { action: 'conversation_search', query: marker })).toEqual({
      error: 'session_id is required for action=conversation_search outside a conversation',
    });
  });

  it('tells an empty conversation apart from a miss', async () => {
    const empty = await sessionWith(alice, 'Empty', []);
    const tool = createSessionQueryTool(db, { userId: alice, userRole: 'team', sessionId: empty });
    expect(await execute(tool, { action: 'conversation_search', query: marker })).toEqual({
      error: 'This conversation has no messages yet — there is nothing to search.',
    });

    const busy = createSessionQueryTool(db, { userId: alice, userRole: 'team', sessionId: aliceContent });
    expect(await execute(busy, { action: 'conversation_search', query: 'nonexistentterm' })).toMatchObject({
      found: 0,
      matches: [],
    });
  });
});
